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

from collections.abc import AsyncIterator
from typing import Any, cast

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.redis.append import append_bytes as _append
from mirage.core.redis.constants import SCOPE_ERROR
from mirage.core.redis.copy import copy as _copy
from mirage.core.redis.create import create as _create
from mirage.core.redis.du import entries as _du_entries
from mirage.core.redis.du import size as _du_size
from mirage.core.redis.exists import exists as _exists
from mirage.core.redis.find import find as _find
from mirage.core.redis.mkdir import mkdir as _mkdir
from mirage.core.redis.read import read as _read
from mirage.core.redis.readdir import readdir as _readdir
from mirage.core.redis.rename import rename as _rename
from mirage.core.redis.rm import rm_r as _rm_r
from mirage.core.redis.rmdir import rmdir as _rmdir
from mirage.core.redis.set_attrs import set_attrs as _set_attrs
from mirage.core.redis.stat import stat as _stat
from mirage.core.redis.stream import read_stream as _read_stream
from mirage.core.redis.truncate import truncate as _truncate
from mirage.core.redis.unlink import unlink as _unlink
from mirage.core.redis.write import write as _write
from mirage.types import FileStat, PathSpec
from mirage.vfs.types import DuEntries

try:
    import redis as sync_redis
except ImportError as _err:
    raise ImportError(
        "RedisVFS requires the 'redis' extra. "
        "Install with: pip install mirage-ai[redis]"
    ) from _err

from mirage.accessor.redis import RedisAccessor
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

    reads_ranges: bool = True
    local: bool = True
    max_glob_matches: int | None = SCOPE_ERROR

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

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await _readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        if not offset and size is None:
            return await _read(self.accessor, path, index)
        return await _read(self.accessor, path, index, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path, index)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def find(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        **predicates: Any,
    ) -> list[str]:
        return await _find(self.accessor, path, index=index, **predicates)

    async def du_size(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> int:
        return await _du_size(self.accessor, path, index)

    async def du_entries(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> DuEntries:
        return await _du_entries(self.accessor, path, index)

    async def write(self, path: PathSpec, data: bytes) -> None:
        await _write(self.accessor, path, data)

    async def append(
        self,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await _append(self.accessor, path, data)

    async def create(self, path: PathSpec) -> None:
        await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        await _rmdir(self.accessor, path, index)

    async def rm_r(self, path: PathSpec) -> Any:
        return await _rm_r(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await _rename(self.accessor, src, dst)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        await _copy(self.accessor, src, dst)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await _truncate(self.accessor, path, length, no_create)

    async def setattr(
        self,
        path: PathSpec,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
    ) -> dict[str, int | str]:
        return await _set_attrs(
            self.accessor,
            path,
            mode=mode,
            uid=uid,
            gid=gid,
            atime=atime,
            mtime=mtime,
        )

    def is_mounted(self) -> bool:
        return self.accessor.store is not None

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
            dirs = sorted(
                m.decode() if isinstance(m, bytes) else m for m in members
            )
            attrs: dict[str, dict[str, str]] = {}
            attrs_pattern = f"{escape_glob(prefix)}attrs:*"
            astrip = len(f"{prefix}attrs:")
            for key in client.scan_iter(attrs_pattern):
                if isinstance(key, bytes):
                    key = key.decode()
                raw = cast("dict[bytes, bytes]", client.hgetall(key))
                attrs[key[astrip:]] = {
                    (k.decode() if isinstance(k, bytes) else k): (
                        v.decode() if isinstance(v, bytes) else v
                    )
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
                    modified[key[mstrip:]] = (
                        val.decode() if isinstance(val, bytes) else val
                    )
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
