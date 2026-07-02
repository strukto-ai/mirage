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
import weakref

try:
    import redis as sync_redis
    from redis.asyncio import Redis
except ImportError as _err:
    raise ImportError("RedisStore requires the 'redis' extra. "
                      "Install with: pip install mirage-ai[redis]") from _err


def _purge_client(clients_dict: dict, loop_id: int) -> None:
    clients_dict.pop(loop_id, None)


class RedisStore:

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        client: Redis | None = None,
        key_prefix: str = "mirage:fs:",
    ) -> None:
        self._url = url
        self._explicit_client = client
        self._prefix = key_prefix
        self._clients: dict[int, Redis] = {}
        sr = sync_redis.Redis.from_url(url)
        sr.sadd(self._dk(), "/")
        sr.close()

    @property
    def _client(self) -> Redis:
        if self._explicit_client is not None:
            return self._explicit_client
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        loop_id = id(loop) if loop is not None else 0
        client = self._clients.get(loop_id)
        if client is not None:
            return client
        client = Redis.from_url(self._url)
        self._clients[loop_id] = client
        if loop is not None:
            weakref.finalize(loop, _purge_client, self._clients, loop_id)
        return client

    def _fk(self, path: str) -> str:
        return f"{self._prefix}file:{path}"

    def _dk(self) -> str:
        return f"{self._prefix}dir"

    def _mk(self, path: str) -> str:
        return f"{self._prefix}modified:{path}"

    async def get_file(self, path: str) -> bytes | None:
        return await self._client.get(self._fk(path))

    async def set_file(self, path: str, data: bytes) -> None:
        await self._client.set(self._fk(path), data)

    async def del_file(self, path: str) -> None:
        await self._client.delete(self._fk(path))

    async def has_file(self, path: str) -> bool:
        return bool(await self._client.exists(self._fk(path)))

    async def list_files(self, prefix: str = "") -> list[str]:
        pattern = f"{self._prefix}file:{prefix}*"
        strip = len(f"{self._prefix}file:")
        result: list[str] = []
        async for key in self._client.scan_iter(pattern):
            if isinstance(key, bytes):
                key = key.decode()
            result.append(key[strip:])
        return sorted(result)

    async def file_len(self, path: str) -> int:
        length = await self._client.strlen(self._fk(path))
        return length

    async def has_dir(self, path: str) -> bool:
        return bool(await self._client.sismember(self._dk(), path))

    async def add_dir(self, path: str) -> None:
        await self._client.sadd(self._dk(), path)

    async def remove_dir(self, path: str) -> None:
        await self._client.srem(self._dk(), path)

    async def list_dirs(self) -> set[str]:
        members = await self._client.smembers(self._dk())
        return {m.decode() if isinstance(m, bytes) else m for m in members}

    async def get_modified(self, path: str) -> str | None:
        val = await self._client.get(self._mk(path))
        if val is None:
            return None
        return val.decode() if isinstance(val, bytes) else val

    async def set_modified(self, path: str, ts: str) -> None:
        await self._client.set(self._mk(path), ts)

    async def del_modified(self, path: str) -> None:
        await self._client.delete(self._mk(path))

    async def clear(self) -> None:
        prefixes = [
            f"{self._prefix}file:*",
            f"{self._prefix}modified:*",
        ]
        for pattern in prefixes:
            keys: list = []
            async for k in self._client.scan_iter(pattern):
                keys.append(k)
            if keys:
                await self._client.delete(*keys)
        await self._client.delete(self._dk())

    async def close(self) -> None:
        if self._explicit_client is not None:
            await self._explicit_client.aclose()
            return
        for client in self._clients.values():
            await client.aclose()
        self._clients.clear()
