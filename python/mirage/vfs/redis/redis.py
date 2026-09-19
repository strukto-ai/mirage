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

from typing import Any, cast

try:
    import redis as sync_redis
except ImportError as _err:
    raise ImportError("RedisVFS requires the 'redis' extra. "
                      "Install with: pip install mirage-ai[redis]") from _err

from mirage.accessor.redis import RedisAccessor
from mirage.commands.builtin.redis import COMMANDS as REDIS_COMMANDS
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.redis import OPS as REDIS_OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.redis.prompt import PROMPT
from mirage.vfs.redis.store import RedisStore, escape_glob
from mirage.vfs.secrets import REDACTED_SECRET


class RedisVFS(BaseVFS):

    accessor: RedisAccessor
    name: str = VFSName.REDIS
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    index_ttl: float = 0
    prompt: str = PROMPT

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:fs:",
    ) -> None:
        super().__init__()
        self.url = url
        self.key_prefix = key_prefix
        self._store = RedisStore(url=url, key_prefix=key_prefix)
        self.accessor = RedisAccessor(self._store)

    def ops(self) -> list[RegisteredOp]:
        return REDIS_OPS

    def commands(self) -> list[RegisteredCommand]:
        return registered_commands(REDIS_COMMANDS)

    def storage_location(self) -> str:
        # The server URL (host, port and db) plus the key prefix pin the
        # keyspace two mounts would share. The prefix is joined path-like
        # so nested prefixes collapse onto one key.
        prefix = self.key_prefix.strip("/")
        base = f"{self.name}:{self.url}"
        return f"{base}/{prefix}" if prefix else base

    def get_state(self) -> dict[str, Any]:
        prefix = self._store._prefix
        url = self._store._url
        client = sync_redis.Redis.from_url(url)
        try:
            files: dict[str, bytes] = {}
            file_pattern = f"{escape_glob(prefix)}file:*"
            strip = len(f"{prefix}file:")
            for key in client.scan_iter(file_pattern):
                if isinstance(key, bytes):
                    key = key.decode()
                # redis-py's sync client is typed with an async-or-sync
                # union (ResponseT); this path is sync, so narrow it.
                data = cast("bytes | None", client.get(key))
                if data is not None:
                    files[key[strip:]] = data
            dir_key = f"{prefix}dir"
            members = cast("set[bytes]", client.smembers(dir_key))
            dirs = sorted(m.decode() if isinstance(m, bytes) else m
                          for m in members)
            attrs: dict[str, dict[str, str]] = {}
            attrs_pattern = f"{escape_glob(prefix)}attrs:*"
            astrip = len(f"{prefix}attrs:")
            for key in client.scan_iter(attrs_pattern):
                if isinstance(key, bytes):
                    key = key.decode()
                raw = cast("dict[bytes, bytes]", client.hgetall(key))
                attrs[key[astrip:]] = {
                    (k.decode() if isinstance(k, bytes) else k):
                    (v.decode() if isinstance(v, bytes) else v)
                    for k, v in raw.items()
                }
            modified: dict[str, str] = {}
            mod_pattern = f"{escape_glob(prefix)}modified:*"
            mstrip = len(f"{prefix}modified:")
            for key in client.scan_iter(mod_pattern):
                if isinstance(key, bytes):
                    key = key.decode()
                val = cast("bytes | None", client.get(key))
                if val is not None:
                    modified[key[mstrip:]] = (val.decode() if isinstance(
                        val, bytes) else val)
        finally:
            client.close()
        return {
            "type": self.name,
            "config": {
                "url": REDACTED_SECRET,
                "key_prefix": prefix,
            },
            "key_prefix": prefix,
            "files": files,
            "dirs": dirs,
            "attrs": attrs,
            "modified": modified,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        files = state.get("files", {})
        dirs = state.get("dirs", ["/"])
        prefix = self._store._prefix
        client = sync_redis.Redis.from_url(self._store._url)
        try:
            pipe = client.pipeline()
            for p, data in files.items():
                pipe.set(f"{prefix}file:{p}", data)
            for d in dirs:
                pipe.sadd(f"{prefix}dir", d)
            for p, fields in state.get("attrs", {}).items():
                if fields:
                    pipe.hset(f"{prefix}attrs:{p}", mapping=fields)
            for p, ts in state.get("modified", {}).items():
                pipe.set(f"{prefix}modified:{p}", ts)
            pipe.execute()
        finally:
            client.close()

    async def close(self) -> None:
        if self._closed:
            return
        await self._store.close()
        await super().close()
