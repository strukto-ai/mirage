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

import dataclasses
from typing import Any, cast

try:
    import redis as sync_redis
except ImportError as _err:
    raise ImportError("RedisResource requires the 'redis' extra. "
                      "Install with: pip install mirage-ai[redis]") from _err

from mirage.accessor.redis import RedisAccessor
from mirage.commands.builtin.redis import COMMANDS as REDIS_COMMANDS
from mirage.core.redis.append import append_bytes
from mirage.core.redis.constants import SCOPE_ERROR
from mirage.core.redis.copy import copy
from mirage.core.redis.create import create
from mirage.core.redis.du import du, du_all
from mirage.core.redis.exists import exists
from mirage.core.redis.find import find
from mirage.core.redis.mkdir import mkdir
from mirage.core.redis.read import read_bytes
from mirage.core.redis.readdir import readdir
from mirage.core.redis.rename import rename
from mirage.core.redis.rm import rm_r
from mirage.core.redis.rmdir import rmdir
from mirage.core.redis.stat import stat as redis_stat
from mirage.core.redis.stream import read_stream
from mirage.core.redis.truncate import truncate
from mirage.core.redis.unlink import unlink
from mirage.core.redis.write import write_bytes
from mirage.ops.redis import OPS as REDIS_OPS
from mirage.resource.base import BaseResource
from mirage.resource.redis.prompt import PROMPT
from mirage.resource.redis.store import RedisStore
from mirage.resource.secrets import REDACTED_SECRET
from mirage.types import PathSpec, ResourceName
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_key

_resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)

_REDIS_OPS = {
    "read_bytes": read_bytes,
    "write": write_bytes,
    "readdir": readdir,
    "stat": redis_stat,
    "unlink": unlink,
    "rmdir": rmdir,
    "copy": copy,
    "rename": rename,
    "mkdir": mkdir,
    "read_stream": read_stream,
    "rm_recursive": rm_r,
    "du_total": du,
    "du_all": du_all,
    "create": create,
    "truncate": truncate,
    "exists": exists,
    "find_flat": find,
    "append": append_bytes,
}


class RedisResource(BaseResource):

    accessor: RedisAccessor
    name: str = ResourceName.REDIS
    index_ttl: float = 0
    _ops: dict[str, Any] = _REDIS_OPS
    PROMPT: str = PROMPT

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:fs:",
    ) -> None:
        super().__init__()
        self._store = RedisStore(url=url, key_prefix=key_prefix)
        self.accessor = RedisAccessor(self._store)
        for fn in REDIS_COMMANDS:
            self.register(fn)
        for fn in REDIS_OPS:
            self.register_op(fn)

    async def resolve_glob(self, paths, prefix: str = ""):
        if prefix:
            paths = [
                dataclasses.replace(p,
                                    resource_path=mount_key(p.virtual, prefix))
                if isinstance(p, PathSpec) else p for p in paths
            ]
        return await _resolve_glob(self.accessor, paths, self._index)

    def get_state(self) -> dict[str, Any]:
        prefix = self._store._prefix
        url = self._store._url
        client = sync_redis.Redis.from_url(url)
        try:
            files: dict[str, bytes] = {}
            file_pattern = f"{prefix}file:*"
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
            attrs_pattern = f"{prefix}attrs:*"
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
            mod_pattern = f"{prefix}modified:*"
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
