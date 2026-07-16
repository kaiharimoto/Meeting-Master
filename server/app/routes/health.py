"""Health check — intentionally unauthenticated so the laptop (and Tailscale
monitoring) can probe reachability without a token."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}
