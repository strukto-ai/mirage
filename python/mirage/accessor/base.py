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

from collections.abc import Hashable, Iterable
from types import TracebackType
from typing import Any, Self

from pydantic import BaseModel

from mirage.accessor.responses import ResponseCache
from mirage.core.api.client import SessionPool
from mirage.core.api.constants import DEFAULT_TIMEOUT
from mirage.core.api.oauth import TokenManager
from mirage.types import JsonValue, ReadSpec
from mirage.utils.clock import Clock


class Accessor:
    async def close(self) -> None:
        return None

    def join(self, peers: Iterable["Accessor"]) -> None:
        """Share what a peer on the same account holds; the default
        shares nothing.

        Args:
            peers (Iterable[Accessor]): the workspace's other accessors.
        """
        return None

    def reaches(self, peer: "Accessor") -> bool:
        """Whether a write through this accessor may change what ``peer``
        reads. True by default: a client may reach anything.

        Args:
            peer (Accessor): another of the workspace's accessors.
        """
        return True

    def caches(self) -> Iterable[ResponseCache[Any, Any]]:
        """The answers this accessor keeps of its own service; none by
        default."""
        return ()

    def govern(self, read: ReadSpec) -> None:
        """Keep this accessor's own answers under a mount's read policy.

        Args:
            read (ReadSpec): the read policy of a mount it serves.
        """
        for cache in self.caches():
            cache.govern(read)

    def forget(self) -> None:
        """Drop this accessor's own answers, as its mount drops its
        caches."""
        for cache in self.caches():
            cache.clear()

    def bind_clock(self, clock: Clock, owner: Hashable) -> None:
        """Read time and wait on the clock of a workspace that mounts it;
        the default reads none.

        Args:
            clock (Clock): the workspace's clock.
            owner (Hashable): who holds it, released by the same key.
        """
        return None

    def release_clock(self, owner: Hashable) -> None:
        """Let ``owner`` go, as it unmounts the accessor or closes; the
        default holds none.

        Args:
            owner (Hashable): the key it was bound with.
        """
        return None


class TokenAccessor(Accessor):
    """An accessor whose calls a ``TokenManager`` signs.

    The manager reads token expiry and times retry waits on the clock of
    the workspace that mounts the accessor, and owns the connection pool
    its calls ride, which ``close`` drains. A subclass sets
    ``token_manager``.
    """

    token_manager: TokenManager

    async def close(self) -> None:
        """Drain the token manager's connection pool. Idempotent."""
        await self.token_manager.close()

    def bind_clock(self, clock: Clock, owner: Hashable) -> None:
        """Read token expiry and retry waits on ``clock``.

        Args:
            clock (Clock): the workspace's clock.
            owner (Hashable): who holds it, released by the same key.

        Raises:
            ValueError: a workspace on another clock mounts it.
        """
        self.token_manager.bind_clock(clock, owner)

    def release_clock(self, owner: Hashable) -> None:
        """Let ``owner`` go.

        Args:
            owner (Hashable): the key it was bound with.
        """
        self.token_manager.release_clock(owner)


class SessionAccessor(Accessor):
    """An accessor whose backend is reached over HTTP.

    Owns the connection pool its backend's calls ride (see
    ``SessionPool`` for why per-call sessions are not an option), so a
    VFS or CLI install drains it through the ordinary ``close`` chain.
    A one-shot accessor is used as an async context manager instead.
    Callers thread the inert ``pool``; ``resolve_session`` materializes
    it at the request.

    Args:
        timeout (float): seconds a request may wait to connect, or between
            two reads of its response; 0 is no bound.
        retry_connection (bool): allow aiohttp's automatic connection retry.
    """

    def __init__(
        self,
        timeout: float = DEFAULT_TIMEOUT,
        *,
        retry_connection: bool = True,
    ) -> None:
        self.pool = SessionPool(
            timeout=timeout, retry_connection=retry_connection
        )

    async def close(self) -> None:
        await self.pool.close()

    def share(self, other: "SessionAccessor") -> None:
        """Ride ``other``'s pool; whichever closes last drains it.

        Args:
            other (SessionAccessor): the accessor whose pool to ride.
        """
        self.pool = other.pool.share()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.close()


class NOOPAccessor(Accessor):
    """The accessor of a mount or CLI with no client of its own.

    Args:
        config (BaseModel | dict[str, JsonValue] | None): the install's
            validated config.
    """

    def __init__(
        self, config: BaseModel | dict[str, JsonValue] | None = None
    ) -> None:
        self.config = config
