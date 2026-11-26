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
from typing import Any, cast

import jwt as pyjwt
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


def admit_account(scope: Scope, account: str | None) -> None:
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


class CredentialRejected(ValueError):
    """The configured server credentials did not admit this token."""


class CredentialVerifier:
    """Verify server credentials and share the issuer key cache."""

    def __init__(self, config: AuthConfig) -> None:
        self.config = config
        jwks_url = config.jwt.jwks_url if config.jwt is not None else None
        self._jwks = (
            pyjwt.PyJWKClient(jwks_url) if jwks_url is not None else None
        )

    async def account(self, token: str) -> str | None:
        cfg = self.config
        if cfg.mode == AuthMode.JWT:
            if cfg.jwt is None:
                raise CredentialRejected("JWT auth is not configured")
            if not _JWT_SHAPE.match(token):
                raise CredentialRejected("token shape is not a JWT")
            try:
                key = await self._signing_key(token)
                return cast(str, verify_jwt(token, cfg.jwt, key)["sub"])
            except JWTVerificationError as exc:
                raise CredentialRejected(str(exc)) from exc

        expected = (
            cfg.local_token if cfg.mode == AuthMode.LOCAL else cfg.bearer_token
        )
        if expected is None or not hmac.compare_digest(
            token.encode(), expected.encode()
        ):
            raise CredentialRejected("credential mismatch")
        return None

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


class AuthMiddleware:
    """Authenticate native requests and attach the signed-in account."""

    def __init__(
        self, app: ASGIApp, config: AuthConfig | CredentialVerifier
    ) -> None:
        self.app = app
        self.verifier = (
            CredentialVerifier(config)
            if isinstance(config, AuthConfig)
            else config
        )

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if (
            scope["type"] not in ("http", "websocket")
            or scope.get("path") in PUBLIC_PATHS
        ):
            await self.app(scope, receive, send)
            return
        cfg = self.verifier.config
        account = None
        try:
            if cfg.mode != AuthMode.LOCAL or cfg.local_token is not None:
                token = _extract_bearer(scope)
                if token is None:
                    raise CredentialRejected("missing bearer token")
                account = await self.verifier.account(token)
        except CredentialRejected as exc:
            client = scope.get("client") or ("?", 0)
            logger.warning(
                "rejecting request from %s:%s: %s", client[0], client[1], exc
            )
            response = error_response(
                ErrorCode.UNAUTHORIZED,
                "unauthorized",
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return
        admit_account(scope, account)
        await self.app(scope, receive, send)
