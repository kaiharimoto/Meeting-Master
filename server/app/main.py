"""Meeting Master — home AI server entry point.

Run from the server/ directory:  python -m app.main
Listens on 0.0.0.0:8080 — reachable over Tailscale from the laptop.

Until the server is configured (a BEARER_TOKEN exists), the /jobs API answers
with a friendly 503 and the operator finishes setup through the loopback-only
wizard at http://127.0.0.1:8080/setup (see app/setup/). The frozen desktop
build (app/desktop.py) opens that page automatically on first run.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import updates
from .config import get_settings
from .events import EventBroker, RingLogHandler
from .routes import admin, health, jobs, live, monitor
from .setup import routes as setup_routes
from .store import JobStore
from .worker import reset_queue, worker_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

# Module-level singleton store. Routes access it via request.app.state.store;
# get_store() exists for anything outside a request context (tests, scripts).
store = JobStore(get_settings())


def get_store() -> JobStore:
    return store


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.models_dir.mkdir(parents=True, exist_ok=True)
    store.load_all()
    app.state.store = store

    # Live monitoring: the broker fans job/log events out to SSE subscribers.
    broker = EventBroker()
    broker.bind_loop(asyncio.get_running_loop())
    log_ring = RingLogHandler(broker)
    logging.getLogger().addHandler(log_ring)
    # publish_threadsafe is correct from any thread INCLUDING the loop thread,
    # so the store observer never has to care where update() was called from.
    store.on_change = lambda record: broker.publish_threadsafe(
        "job", monitor.trim_job(record)
    )
    app.state.broker = broker
    app.state.log_ring = log_ring

    reset_queue()  # bind the job queue to this event loop (see worker.py)
    worker_task = asyncio.create_task(worker_loop(store))
    update_task = asyncio.create_task(updates.periodic_check_loop())
    log.info("Home AI server ready (data dir: %s)", settings.data_dir)
    try:
        yield
    finally:
        for task in (worker_task, update_task):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        store.on_change = None
        logging.getLogger().removeHandler(log_ring)


app = FastAPI(title="Meeting Master — Home AI Server", lifespan=lifespan)
app.include_router(health.router)
app.include_router(setup_routes.router)
app.include_router(jobs.router)
app.include_router(live.router)
app.include_router(monitor.router)
app.include_router(admin.router)


if __name__ == "__main__":
    import uvicorn

    # Proxy options stated explicitly — see desktop.py for why the
    # loopback-only /setup guard depends on them.
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8080,
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
    )
