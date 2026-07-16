"""Meeting Master — home AI server entry point.

Run from the server/ directory:  python -m app.main
Listens on 0.0.0.0:8080 — reachable over Tailscale from the laptop.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import get_settings
from .routes import health, jobs
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
    store.load_all()
    app.state.store = store
    reset_queue()  # bind the job queue to this event loop (see worker.py)
    worker_task = asyncio.create_task(worker_loop(store))
    log.info("Home AI server ready (data dir: %s)", settings.data_dir)
    try:
        yield
    finally:
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Meeting Master — Home AI Server", lifespan=lifespan)
app.include_router(health.router)
app.include_router(jobs.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8080)
