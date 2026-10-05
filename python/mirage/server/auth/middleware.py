# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import hmac
import logging
import re
from typing import Any

import jwt as pyjwt
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from mirage.concurrency.limiter import run_blocking
from mirage.server.auth.config import (
    PROTECTED_RESOURCE_PATH,
    AuthConfig,
    AuthMode,
)
from mirage.server.auth.jwt import JWTVerificationError, verify_jwt

logger = logging.getLogger(__name__)

BEARER_PREFIX = "Bearer "
PUBLIC_PATHS: frozenset[str] = frozenset(
    {"/v1/health", PROTECTED_RESOURCE_PATH}
)
_JWT_SHAPE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


def _admit(scope: Scope, account: str | None) -> None:
    """Record who the request runs as, read by routes as
    ``request.state.account``.

    Args:
        scope (Scope): the request scope.
        account (str | None): the JWT's ``sub``; None when the mode
            names no account (local or shared token), which may use
            every workspace.
    """
    scope.setdefault("state", {})["account"] = account


class AuthMiddleware:
    """ASGI middleware enforcing the daemon's auth mode.

    Every admitted request carries its account in the scope state:
    the JWT's ``sub`` in jwt mode, None otherwise.

    Args:
        app (ASGIApp): downstream ASGI app.
        config (AuthConfig): resolved auth configuration.
    """

    def __init__(self, app: ASGIApp, config: AuthConfig) -> None:
        self.app = app
        self.config = config
        jwks_url = config.jwt.jwks_url if config.jwt is not None else None
        self._jwks = (
            pyjwt.PyJWKClient(jwks_url) if jwks_url is not None else None
        )

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if scope.get("path") in PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return
        cfg = self.config
        if cfg.mode == AuthMode.LOCAL and cfg.local_token is None:
            _admit(scope, None)
            await self.app(scope, receive, send)
            return

        token = self._extract_bearer(scope)
        if token is None:
            await self._unauthorized(
                scope, receive, send, "missing bearer token"
            )
            return

        if self.config.mode == AuthMode.JWT:
            if self.config.jwt is None:
                await self._unauthorized(
                    scope, receive, send, "JWT auth is not configured"
                )
                return
            if not _JWT_SHAPE.match(token):
                await self._unauthorized(
                    scope, receive, send, "token shape is not a JWT"
                )
                return
            try:
                key = await self._signing_key(token)
                claims = verify_jwt(token, self.config.jwt, key)
            except JWTVerificationError as e:
                logger.debug("JWT rejected: %s", e)
                await self._unauthorized(scope, receive, send, str(e))
                return
            _admit(scope, claims["sub"])
            await self.app(scope, receive, send)
            return

        expected = (
            self.config.local_token
            if self.config.mode == AuthMode.LOCAL
            else self.config.bearer_token
        )
        if expected is None or not hmac.compare_digest(token, expected):
            await self._unauthorized(scope, receive, send, "bearer mismatch")
            return
        _admit(scope, None)
        await self.app(scope, receive, send)

    async def _signing_key(self, token: str) -> Any | None:
        """The issuer's key for ``token``, fetched by its ``kid``.

        None when the config names the key itself. The key set is
        cached and fetched again for a ``kid`` it does not hold, so an
        issuer's key rotation needs no restart.

        Args:
            token (str): the bearer JWT.

        Raises:
            JWTVerificationError: the key set cannot be fetched, is not
                JSON, or holds no key for the token.
        """
        if self._jwks is None:
            return None
        try:
            found = await run_blocking(
                self._jwks.get_signing_key_from_jwt, token
            )
        except (pyjwt.PyJWTError, ValueError) as e:
            raise JWTVerificationError(f"JWT key lookup failed: {e}") from e
        return found.key

    @staticmethod
    def _extract_bearer(scope: Scope) -> str | None:
        headers = dict(scope.get("headers") or [])
        raw = headers.get(b"authorization", b"").decode("latin-1")
        if not raw.startswith(BEARER_PREFIX):
            return None
        value = raw[len(BEARER_PREFIX) :].strip()
        return value or None

    async def _unauthorized(
        self, scope: Scope, receive: Receive, send: Send, reason: str
    ) -> None:
        client = scope.get("client") or ("?", 0)
        logger.warning(
            "rejecting request from %s:%s: %s", client[0], client[1], reason
        )
        response = PlainTextResponse(
            "Unauthorized",
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
        await response(scope, receive, send)
