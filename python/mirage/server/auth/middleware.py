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
from collections.abc import Callable
from typing import Any

import jwt as pyjwt
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from mirage.concurrency.limiter import run_blocking
from mirage.server.auth.config import (
    PROTECTED_RESOURCE_PATH,
    AuthConfig,
    AuthMode,
)
from mirage.server.auth.jwt import JWTVerificationError, verify_jwt
from mirage.server.errors import ErrorCode, error_response

logger = logging.getLogger(__name__)

BEARER_PREFIX = "Bearer "
PUBLIC_PATHS: frozenset[str] = frozenset(
    {"/v1/health", "/v1/daemon/ready", PROTECTED_RESOURCE_PATH}
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


def _extract_bearer(scope: Scope) -> str | None:
    headers = dict(scope.get("headers") or [])
    raw = headers.get(b"authorization", b"").decode("latin-1")
    if not raw.startswith(BEARER_PREFIX):
        return None
    value = raw[len(BEARER_PREFIX) :].strip()
    return value or None


def _extract_api_key(scope: Scope) -> str | None:
    keys = [value for name, value in scope["headers"] if name == b"x-api-key"]
    if len(keys) != 1:
        return None
    return keys[0].decode("latin-1").strip() or None


async def _unauthorized(
    scope: Scope, receive: Receive, send: Send, reason: str, *, api_key: bool
) -> None:
    client = scope.get("client") or ("?", 0)
    logger.warning(
        "rejecting request from %s:%s: %s", client[0], client[1], reason
    )
    response = (
        JSONResponse({"code": 401, "message": "unauthorized"}, status_code=401)
        if api_key
        else error_response(
            ErrorCode.UNAUTHORIZED,
            "unauthorized",
            headers={"WWW-Authenticate": "Bearer"},
        )
    )
    await response(scope, receive, send)


class AuthMiddleware:
    """ASGI middleware enforcing the daemon's auth mode.

    Every admitted request carries its account in the scope state:
    the JWT's ``sub`` in jwt mode, None otherwise.

    Args:
        app (ASGIApp): downstream ASGI app.
        config (AuthConfig): resolved auth configuration.
        api_key_request (Callable[[Scope], bool] | None): select requests
            that must authenticate with ``X-API-Key``.
        sandbox_request (Callable[[Scope], bool] | None): select requests
            authenticated by a sandbox route's access token.
        sandbox_account (Callable[[Scope], str | None] | None): resolve the
            owning account from an authenticated sandbox request.
    """

    def __init__(
        self,
        app: ASGIApp,
        config: AuthConfig,
        api_key_request: Callable[[Scope], bool] | None = None,
        sandbox_request: Callable[[Scope], bool] | None = None,
        sandbox_account: Callable[[Scope], str | None] | None = None,
    ) -> None:
        self.app = app
        self.config = config
        self.api_key_request = api_key_request
        self.sandbox_request = sandbox_request
        self.sandbox_account = sandbox_account
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
        if (
            scope["type"] == "http"
            and self.sandbox_request is not None
            and self.sandbox_request(scope)
        ):
            account = (
                self.sandbox_account(scope)
                if self.sandbox_account is not None
                else None
            )
            _admit(scope, account)
            await self.app(scope, receive, send)
            return
        cfg = self.config
        use_api_key = (
            scope["type"] == "http"
            and self.api_key_request is not None
            and self.api_key_request(scope)
        )
        if (
            not use_api_key
            and cfg.mode == AuthMode.LOCAL
            and cfg.local_token is None
        ):
            _admit(scope, None)
            await self.app(scope, receive, send)
            return

        token = (
            _extract_api_key(scope) if use_api_key else _extract_bearer(scope)
        )
        if token is None:
            reason = (
                "missing API key" if use_api_key else "missing bearer token"
            )
            await _unauthorized(
                scope, receive, send, reason, api_key=use_api_key
            )
            return

        if self.config.mode == AuthMode.JWT:
            if self.config.jwt is None:
                await _unauthorized(
                    scope,
                    receive,
                    send,
                    "JWT auth is not configured",
                    api_key=use_api_key,
                )
                return
            if not _JWT_SHAPE.match(token):
                await _unauthorized(
                    scope,
                    receive,
                    send,
                    "token shape is not a JWT",
                    api_key=use_api_key,
                )
                return
            try:
                key = await self._signing_key(token)
                claims = verify_jwt(token, self.config.jwt, key)
            except JWTVerificationError as e:
                logger.debug("JWT rejected: %s", e)
                await _unauthorized(
                    scope, receive, send, str(e), api_key=use_api_key
                )
                return
            _admit(scope, claims["sub"])
            await self.app(scope, receive, send)
            return

        expected = (
            self.config.local_token
            if self.config.mode == AuthMode.LOCAL
            else self.config.bearer_token
        )
        if expected is None or not hmac.compare_digest(
            token.encode(), expected.encode()
        ):
            reason = "API key mismatch" if use_api_key else "bearer mismatch"
            await _unauthorized(
                scope, receive, send, reason, api_key=use_api_key
            )
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
