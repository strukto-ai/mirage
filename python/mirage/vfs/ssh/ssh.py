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
from typing import Any

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh.append import append_bytes as _append
from mirage.core.ssh.constants import SCOPE_ERROR
from mirage.core.ssh.copy import copy as _copy
from mirage.core.ssh.create import create as _create
from mirage.core.ssh.du import entries as _du_entries
from mirage.core.ssh.du import size as _du_size
from mirage.core.ssh.exists import exists as _exists
from mirage.core.ssh.find import find as _find
from mirage.core.ssh.mkdir import mkdir as _mkdir
from mirage.core.ssh.pwrite import pwrite as _pwrite
from mirage.core.ssh.read import read as _read
from mirage.core.ssh.readdir import readdir as _readdir
from mirage.core.ssh.rename import rename as _rename
from mirage.core.ssh.rm import rm_r as _rm_r
from mirage.core.ssh.rmdir import rmdir as _rmdir
from mirage.core.ssh.set_attrs import set_attrs as _set_attrs
from mirage.core.ssh.stat import stat as _stat
from mirage.core.ssh.stream import read_stream as _read_stream
from mirage.core.ssh.truncate import truncate as _truncate
from mirage.core.ssh.unlink import unlink as _unlink
from mirage.core.ssh.watch import build_delta_hook
from mirage.core.ssh.write import write as _write
from mirage.types import FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.ssh.config import SSHConfig
from mirage.vfs.ssh.prompt import PROMPT
from mirage.vfs.types import DuEntries
from mirage.watch.base import DeltaHook


class SSHVFS(BaseVFS):
    accessor: SSHAccessor
    name: str = VFSName.SSH
    caches_reads: bool = True
    # SFTP stat/readdir report the remote inode's exact byte size for
    # every file; reads are the same raw bytes.
    sizes_always_known: bool = True
    max_du_entries: int | None = None
    # A remote filesystem: short-lived index, long enough to spare a
    # re-walk inside one command pipeline. Mirrors the TypeScript VFS.
    index_ttl: float = 60
    prompt: str = PROMPT

    reads_ranges: bool = True
    max_glob_matches: int | None = SCOPE_ERROR

    def __init__(self, config: SSHConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = SSHAccessor(self.config)

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

    async def pwrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await _pwrite(self.accessor, path, data, offset)

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
        return self.accessor.root is not None

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
