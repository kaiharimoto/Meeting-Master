"""Bearer-token auth dependency.

Uses secrets.compare_digest (constant-time) so the comparison does not leak
how many leading characters of a guessed token were correct.
"""

import secrets

from fastapi import Header, HTTPException

from .config import get_settings

_UNAUTHORIZED = HTTPException(
    status_code=401,
    detail="Invalid or missing bearer token",
    headers={"WWW-Authenticate": "Bearer"},
)


def verify_token(authorization: str | None = Header(None)) -> None:
    expected = get_settings().BEARER_TOKEN
    # An empty configured token would make 'Bearer ' a valid credential —
    # treat a blank BEARER_TOKEN as "auth always fails" instead.
    if not expected or not authorization:
        raise _UNAUTHORIZED
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _UNAUTHORIZED
    # Encode to bytes: compare_digest on str raises for non-ASCII input.
    if not secrets.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        raise _UNAUTHORIZED
