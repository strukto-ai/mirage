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

from collections.abc import Awaitable
from typing import cast

import redis.asyncio as aioredis

from mirage.observe.store import ObserverStoreBase


class RedisObserverStore(ObserverStoreBase):
    """ObserverStore backed by Redis strings (one key per JSONL file).

    Appends use the atomic Redis APPEND command; an index set tracks
    which file keys exist so read_all needs no SCAN.

    Args:
        url (str): Redis connection URL.
        key_prefix (str): Namespace prefix for all keys.
    """

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:observer:",
    ) -> None:
        self._client = aioredis.from_url(url)
        self._prefix = key_prefix
        self._index_key = f"{key_prefix}keys"

    async def append(self, path: str, data: bytes) -> None:
        """Append bytes to the file at path.

        Args:
            path (str): File key.
            data (bytes): Bytes to append.
        """
        pipe = self._client.pipeline()
        pipe.append(f"{self._prefix}{path}", data)
        pipe.sadd(self._index_key, path)
        await pipe.execute()

    async def write(self, path: str, data: bytes) -> None:
        """Overwrite the file at path.

        Args:
            path (str): File key.
            data (bytes): Full new content.
        """
        pipe = self._client.pipeline()
        pipe.set(f"{self._prefix}{path}", data)
        pipe.sadd(self._index_key, path)
        await pipe.execute()

    async def read_matching(self, suffix: str) -> dict[str, bytes]:
        """Read only the files whose key ends with suffix.

        Filters on the index set, so only matching values transfer.

        Args:
            suffix (str): File-key suffix.

        Returns:
            dict[str, bytes]: Mapping of matching key to content.
        """
        paths = [p for p in await self._indexed_paths() if p.endswith(suffix)]
        return await self._read_paths(paths)

    async def _indexed_paths(self) -> list[str]:
        members = await cast("Awaitable[set[bytes]]",
                             self._client.smembers(self._index_key))
        return sorted(m.decode() if isinstance(m, bytes) else m
                      for m in members)

    async def _read_paths(self, paths: list[str]) -> dict[str, bytes]:
        if not paths:
            return {}
        values = await self._client.mget([f"{self._prefix}{p}" for p in paths])
        return {p: v or b"" for p, v in zip(paths, values)}

    async def clear(self) -> None:
        """Delete every stored file and the index (rewind/teardown)."""
        paths = await self._indexed_paths()
        keys = [f"{self._prefix}{p}" for p in paths] + [self._index_key]
        await self._client.delete(*keys)

    async def close(self) -> None:
        """Close the Redis client connection."""
        await self._client.aclose()
