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
import math
from collections.abc import Hashable
from types import TracebackType
from typing import Self

import aiohttp

from mirage.core.api.client import SessionPool
from mirage.utils.clock import Clock, SystemClock, is_system_clock


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

    A VFS-owned manager is drained by the VFS's ``close``, and a CLI
    install's by its accessor's. A one-shot manager is used as an async
    context manager so the pool it opened dies with the line that
    opened it.

    Expiry is read on ``clock``, which also times the waits between
    retries of the calls the manager signs. A mount hands it the
    workspace's clock through ``bind_clock`` and gives it back through
    ``release_clock``.

    Args:
        buffer_seconds (float): how long before expiry to refresh.
        clock (Clock | None): the clock expiry and retry waits are read
            on; None is the system clock.
    """

    def __init__(
        self, buffer_seconds: float = 300.0, clock: Clock | None = None
    ) -> None:
        self._buffer_seconds = buffer_seconds
        self._access_token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()
        self.pool = SessionPool()
        self.clock: Clock = clock if clock is not None else SystemClock()
        self._holders: set[Hashable] = set()

    def bind_clock(self, clock: Clock, owner: Hashable) -> None:
        """Read expiry and time retry waits on ``clock`` while ``owner``
        holds the manager.

        A workspace holds it from the moment its mounts take its clock
        until it unmounts the VFS or closes; holding again, or letting go
        twice, changes nothing. Expiry and waits can follow one clock
        only, so while another owner holds the manager a different clock
        is refused; two system clocks agree. A refreshed token's expiry
        was read on the clock it replaces, so it is dropped and the next
        call refreshes; a seeded token that never expires is kept.

        Args:
            clock (Clock): the clock of the workspace the manager serves.
            owner (Hashable): who holds it, released by the same key.

        Raises:
            ValueError: another owner holds the manager on another clock.
        """
        same = clock is self.clock or (
            is_system_clock(clock) and is_system_clock(self.clock)
        )
        if not same:
            if self._holders - {owner}:
                raise ValueError(
                    "this client is held by a workspace on another clock; "
                    "unmount or uninstall it there, or give both one clock"
                )
            self.clock = clock
            if self._expires_at != math.inf:
                self._expires_at = 0
        self._holders.add(owner)

    def release_clock(self, owner: Hashable) -> None:
        """Let ``owner`` go; once none holds, another clock may bind.

        Args:
            owner (Hashable): the key it was bound with.
        """
        self._holders.discard(owner)

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

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
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
            if self._access_token and self.clock.now() < self._expires_at:
                return self._access_token
            token, expires_in = await self.refresh_pair()
            self._access_token = token
            self._expires_at = (
                self.clock.now() + expires_in - self._buffer_seconds
            )
            return token
