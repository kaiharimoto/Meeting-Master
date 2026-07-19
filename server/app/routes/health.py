"""Health check — intentionally unauthenticated so the laptop (and Tailscale
monitoring) can probe reachability without a token. It also reports whether the
home server has finished first-run setup, so the laptop can tell "unreachable"
apart from "reachable but not configured yet"."""

from fastapi import APIRouter

from ..config import APP_VERSION, get_settings

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "configured": get_settings().is_configured,
        "version": APP_VERSION,
    }
