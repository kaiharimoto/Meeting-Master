"""Live event distribution for the monitoring UIs.

One EventBroker per server process fans job/log events out to any number of
SSE subscribers (the laptop app and the local dashboard). Events carry
monotonically increasing ids and are kept in a small ring so a reconnecting
client can replay what it missed (SSE Last-Event-ID); anything older than the
ring gets a fresh snapshot instead.

RingLogHandler doubles as the log store: it keeps the last N formatted log
lines in memory (so /logs works even in dev where server.log doesn't exist)
and publishes each line as a `log` event.
"""

import asyncio
import itertools
import json
import logging
import time
from collections import deque
from typing import Optional

log = logging.getLogger(__name__)

# Slow-consumer bound: a subscriber this far behind is dropped and will
# reconnect via the SSE retry mechanism (getting a fresh snapshot).
_SUBSCRIBER_QUEUE_MAX = 512


class EventBroker:
    def __init__(self, ring_size: int = 256) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        # (id, event-name, data-as-json) — newest last.
        self._ring: deque[tuple[int, str, str]] = deque(maxlen=ring_size)
        # Ids are seeded from wall-clock millis so they are unique ACROSS
        # server restarts: a client reconnecting with a Last-Event-ID from a
        # previous boot must never collide with this boot's small ids (which
        # would silently suppress its fresh hello snapshot).
        self._ids = itertools.count(int(time.time() * 1000) * 1000 + 1)
        self._last_id = 0
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # -- lifecycle -----------------------------------------------------------
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the serving loop so non-loop threads can publish safely."""
        self._loop = loop

    @property
    def last_id(self) -> int:
        return self._last_id

    # -- publishing ----------------------------------------------------------
    def publish(self, event: str, data) -> None:
        """Publish an event. MUST be called on the serving event loop."""
        eid = next(self._ids)
        self._last_id = eid
        try:
            payload = (eid, event, json.dumps(data, default=str))
        except (TypeError, ValueError):
            log.warning("Dropping unserializable %s event", event)
            return
        self._ring.append(payload)
        for q in list(self._subscribers):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                # A consumer this far behind is better served by reconnecting.
                # Mark the queue so its SSE generator CLOSES the stream (just
                # discarding it would leave a zombie connection receiving only
                # pings, which the client's watchdog would keep treating as
                # alive — it must see a disconnect to reconnect + resnapshot).
                q._mm_dropped = True  # type: ignore[attr-defined]
                self._subscribers.discard(q)

    def publish_threadsafe(self, event: str, data) -> None:
        """Publish from ANY thread (tray, logging handlers, ...). Safe to call
        from the loop thread too — call_soon_threadsafe handles both."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self.publish, event, data)
        except RuntimeError:
            pass  # loop shutting down — the event is moot

    # -- subscription --------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=_SUBSCRIBER_QUEUE_MAX)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def replay_since(self, last_id: int):
        """Events newer than last_id, IF last_id is still within the ring
        (or is the newest id). Returns None when the id is unknown/too old —
        the caller should send a fresh snapshot instead."""
        if last_id == self._last_id:
            return []
        known = {eid for eid, _, _ in self._ring}
        if last_id not in known:
            return None
        return [entry for entry in self._ring if entry[0] > last_id]


class RingLogHandler(logging.Handler):
    """Keeps the last N formatted log lines and publishes each as an event."""

    def __init__(self, broker: EventBroker, capacity: int = 500) -> None:
        super().__init__()
        self.broker = broker
        self.lines: deque[str] = deque(maxlen=capacity)
        self.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )

    def emit(self, record: logging.LogRecord) -> None:
        # Skip HTTP access logs entirely: with uvicorn's default config they
        # never propagate to root anyway, and under a custom config they would
        # be pure noise (the dashboard/laptop polling would evict real lines
        # from the ring within minutes). The ring is for app/pipeline logs.
        if record.name == "uvicorn.access":
            return
        try:
            line = self.format(record)
        except Exception:
            return
        self.lines.append(line)
        # Logging happens on arbitrary threads — always route via the loop.
        self.broker.publish_threadsafe("log", {"line": line})

    def tail(self, n: int) -> list[str]:
        if n <= 0:
            return []
        return list(self.lines)[-n:]
