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

import functools
import os
from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.generic.rewrite import append_by_rewrite
from mirage.core.s3.constants import SCOPE_ERROR
from mirage.core.s3.copy import copy as _copy
from mirage.core.s3.create import create as _create
from mirage.core.s3.du import entries as _du_entries
from mirage.core.s3.du import size as _du_size
from mirage.core.s3.exists import exists as _exists
from mirage.core.s3.find import find as _find
from mirage.core.s3.mkdir import mkdir as _mkdir
from mirage.core.s3.read import read as _read
from mirage.core.s3.readdir import readdir as _readdir
from mirage.core.s3.rename import rename as _rename
from mirage.core.s3.rm import rm_r as _rm_r
from mirage.core.s3.rmdir import rmdir as _rmdir
from mirage.core.s3.stat import stat as _stat
from mirage.core.s3.stream import read_stream as _read_stream
from mirage.core.s3.truncate import truncate as _truncate
from mirage.core.s3.unlink import unlink as _unlink
from mirage.core.s3.watch import build_delta_hook
from mirage.core.s3.write import write as _write
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.s3.config import S3Config
from mirage.vfs.s3.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook


def _declared_endpoint(config: S3Config) -> str | None:
    """The endpoint a mount declares, for its write-condition row.

    The config's, else ``AWS_ENDPOINT_URL_S3`` or ``AWS_ENDPOINT_URL``
    unless ``AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`` is true. An endpoint
    set only in an AWS profile is not read.

    Args:
        config (S3Config): the mount's config.
    """
    if config.endpoint_url:
        return config.endpoint_url
    env = os.environ
    if env.get("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", "").lower() == "true":
        return None
    return (
        env.get("AWS_ENDPOINT_URL_S3") or env.get("AWS_ENDPOINT_URL") or None
    )


class S3VFS(BaseVFS):
    accessor: S3Accessor
    name: str = VFSName.S3
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    caches_reads: bool = True
    prompt: str = PROMPT
    supports_snapshot: bool = True
    # stat and read both stamp the ETag, so the gate compares like with
    # like. Inherited by every S3AliasVFS provider.
    read_revalidatable: bool = True

    reads_ranges: bool = True
    max_glob_matches: int | None = SCOPE_ERROR

    def __init__(self, config: S3Config) -> None:
        super().__init__()
        self.config = config
        self.accessor = S3Accessor(self.config)
        self._endpoint = _declared_endpoint(config)

    def resolved_endpoint(self) -> str | None:
        """The endpoint this mount declared when it was built.

        Fixed then, so the load-time verdict and every later write judge
        the same endpoint. Mirrors TS ``resolvedEndpoint``.
        """
        return self._endpoint

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
        await append_by_rewrite(
            functools.partial(self.read, index=index),
            self.write,
            functools.partial(self.stat, index=index),
            path,
            data,
        )

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

    def storage_location(self) -> str:
        # Endpoint, bucket and key prefix pin the object namespace. The
        # endpoint matters because the same bucket name on two providers
        # (AWS vs MinIO vs R2) is two different stores, so it, not an
        # alias's name, tells them apart: an s3 mount and a minio mount of
        # one endpoint and bucket are one store. The prefix joins
        # path-like so two mounts whose prefixes nest still resolve to
        # one key once the mount-relative path is appended.
        cfg = self.config
        prefix = (cfg.key_prefix or "").strip("/")
        base = f"{VFSName.S3}:{cfg.endpoint_url or 'aws'}:{cfg.bucket}"
        return f"{base}/{prefix}" if prefix else base

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
