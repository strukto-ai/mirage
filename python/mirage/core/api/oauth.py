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

import asyncio
import time
from types import TracebackType
from typing import Self

import aiohttp

from mirage.core.api.client import SessionPool


class TokenManager:
    """Caches a short-lived access token, refreshing before expiry.

    Subclasses implement ``refresh_pair`` with their provider's grant.
    The refresh runs under a lock so concurrent callers share one
    round-trip, and ``buffer_seconds`` refreshes early so a token never
    expires mid-request.

    The manager also owns the ``aiohttp`` session its backend's calls
    ride, because it is the one object already threaded into every call.
    A session per request is a TCP connect per request, and the closing
    side parks each socket in TIME_WAIT: a full local battery peaked at
    6169 parked sockets from one backend alone, and with several
    backends back to back the ~16k ephemeral ports ran out as
    EADDRNOTAVAIL mid-run. Linux masks this by reusing loopback
    TIME_WAIT sockets and TypeScript never had it (undici pools
    ambiently), which is why it only ever surfaced as a flaky macOS
    battery.

    A resource-owned manager is drained by the resource's ``close``. A
    one-shot manager, which is what a CLI verb builds per invocation,
    is used as an async context manager so the pool it opened dies with
    the line that opened it.
    """

    def __init__(self, buffer_seconds: float = 300.0) -> None:
        self._buffer_seconds = buffer_seconds
        self._access_token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()
        self.pool = SessionPool()

    def session(self) -> aiohttp.ClientSession:
        """The live session, materialized from ``pool`` on first use.

        Callers that thread a session onward pass ``pool`` instead and
        let ``resolve_session`` materialize it at the request; this is
        for code performing I/O itself, a stream holding a connection.

        Returns:
            aiohttp.ClientSession: one keep-alive pool for every call
            this manager authenticates; recreated if it was closed.
        """
        return self.pool.get()

    async def close(self) -> None:
        """Drain the pool. Idempotent, and safe before first use."""
        await self.pool.close()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, exc_type: type[BaseException] | None,
                        exc: BaseException | None,
                        tb: TracebackType | None) -> None:
        await self.close()

    async def refresh_pair(self) -> tuple[str, float]:
        """Fetch a fresh token as ``(access_token, expires_in_seconds)``."""
        raise NotImplementedError

    def seed(self, token: str, expires_at: float) -> None:
        """Preload the cache with a token minted outside the refresh flow.

        Args:
            token (str): the access token to serve.
            expires_at (float): epoch seconds after which ``get_token``
                refreshes again; ``float("inf")`` for a token the manager
                can never replace itself.
        """
        self._access_token = token
        self._expires_at = expires_at

    async def get_token(self) -> str:
        async with self._lock:
            if self._access_token and time.time() < self._expires_at:
                return self._access_token
            token, expires_in = await self.refresh_pair()
            self._access_token = token
            self._expires_at = (time.time() + expires_in -
                                self._buffer_seconds)
            return token
