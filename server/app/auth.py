"""Bearer-token auth dependency.

Uses secrets.compare_digest (constant-time) so the comparison does not leak
how many leading characters of a guessed token were correct.
"""

import logging
import secrets
import time

from fastapi import Header, HTTPException, Request

from .config import get_settings

log = logging.getLogger(__name__)

_UNAUTHORIZED = HTTPException(
    status_code=401,
    detail="Invalid or missing bearer token",
    headers={"WWW-Authenticate": "Bearer"},
)

# The laptop sees one message for every rejection, so the server log is where
# "no header at all" and "a token, but not ours" get told apart. Throttled per
# (client, reason): a disconnected event stream retries every few seconds.
_LOG_EVERY_SEC = 60.0
_last_logged: dict[tuple[str, str], float] = {}


def _reject(request: Request | None, reason: str) -> HTTPException:
    client = request.client.host if request is not None and request.client else "?"
    key = (client, reason)
    now = time.monotonic()
    if now - _last_logged.get(key, float("-inf")) >= _LOG_EVERY_SEC:
        _last_logged[key] = now
        path = request.url.path if request is not None else "?"
        log.warning("Rejected %s from %s: %s", path, client, reason)
    return _UNAUTHORIZED


def verify_token(
    request: Request, authorization: str | None = Header(None)
) -> None:
    # Stripped: the laptop trims the token it pastes, so a hand-edited
    # server.env with a stray space would otherwise never match anything.
    expected = get_settings().BEARER_TOKEN.strip()
    # An empty configured token would make 'Bearer ' a valid credential —
    # treat a blank BEARER_TOKEN as "auth always fails" instead.
    if not expected:
        raise _reject(request, "this server has no BEARER_TOKEN saved")
    if not authorization:
        raise _reject(request, "no Authorization header was sent")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _reject(request, "the Authorization header is not 'Bearer <token>'")
    # Encode to bytes: compare_digest on str raises for non-ASCII input.
    if not secrets.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        raise _reject(
            request,
            "the token does not match this server's — paste the connection "
            "code from this dashboard into the laptop's Settings again",
        )
