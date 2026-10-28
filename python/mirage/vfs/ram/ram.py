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

from collections.abc import AsyncIterator, Awaitable
from typing import Any

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.copy import copy as _copy
from mirage.core.ram.create import create as _create
from mirage.core.ram.exists import exists as _exists
from mirage.core.ram.mkdir import mkdir as _mkdir
from mirage.core.ram.pwrite import pwrite as _pwrite
from mirage.core.ram.read import read as _read
from mirage.core.ram.readdir import readdir as _readdir
from mirage.core.ram.readdir import tree as _tree
from mirage.core.ram.rename import rename as _rename
from mirage.core.ram.rm import rm_r as _rm_r
from mirage.core.ram.rmdir import rmdir as _rmdir
from mirage.core.ram.set_attrs import set_attrs as _set_attrs
from mirage.core.ram.stat import stat as _stat
from mirage.core.ram.truncate import truncate as _truncate
from mirage.core.ram.unlink import unlink as _unlink
from mirage.core.ram.write import write as _write
from mirage.io.types import ByteSource
from mirage.types import CapacityResult, FileStat, PathSpec, VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.capacity import storage_usage
from mirage.vfs.constants import LOCAL_WALK_LIMIT
from mirage.vfs.ram.store import RAMFiles, RAMStore


class RAMVFS(BaseVFS):
    accessor: RAMAccessor
    name: str = VFSName.RAM
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    index_ttl: float = 0

    reads_ranges: bool = True
    local: bool = True
    walk_limit: int = LOCAL_WALK_LIMIT

    def __init__(self, capacity: int | str | None = None) -> None:
        """A store in process memory.

        Args:
            capacity (int | str | None): the most bytes the store may hold,
                a size like ``100MB`` or a count of bytes; None for no
                limit. Every mount of the store shares it.

        Raises:
            VFSConfigError: ``capacity`` is not a size.
        """
        super().__init__()
        self.usage = storage_usage(self.name, capacity, used=0)
        self._store = RAMStore(files=RAMFiles(self.usage), usage=self.usage)
        self.accessor = RAMAccessor(self._store)

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await _readdir(self.accessor, path)

    def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> Awaitable[ByteSource] | AsyncIterator[bytes]:
        return _read(self.accessor, path, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def read_tree(self, path: PathSpec) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path)

    async def write(
        self, path: PathSpec, data: ByteSource, *, atomic: bool = False
    ) -> None:
        await _write(self.accessor, path, data, atomic=atomic)

    async def append(self, path: PathSpec, data: ByteSource) -> None:
        await _write(self.accessor, path, data, append=True)

    async def pwrite(self, path: PathSpec, data: bytes, offset: int) -> None:
        await _pwrite(self.accessor, path, data, offset)

    async def create(self, path: PathSpec) -> None:
        await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(self, path: PathSpec) -> None:
        await _rmdir(self.accessor, path)

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

    def get_state(self) -> dict[str, Any]:
        state: dict[str, Any] = {
            "type": self.name,
            "files": dict(self._store.files),
            "dirs": list(self._store.dirs),
            "modified": dict(self._store.modified),
            "attrs": {k: dict(v) for k, v in self._store.attrs.items()},
        }
        if self.usage is not None:
            state["config"] = {"capacity": self.usage.limit}
        return state

    def load_state(self, state: dict[str, Any]) -> None:
        self._store.files.clear()
        for key, data in state.get("files", {}).items():
            self._store.files[key] = data
        self._store.dirs = set(state.get("dirs", ["/"]))
        self._store.modified = dict(state.get("modified", {}))
        self._store.attrs = {
            k: dict(v) for k, v in state.get("attrs", {}).items()
        }

    async def capacity(self) -> CapacityResult:
        """df's QUOTA row for a capped store; the base UNKNOWN otherwise."""
        if self.usage is not None:
            return self.usage.report()
        return await super().capacity()
