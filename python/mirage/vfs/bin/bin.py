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

from collections.abc import Callable
from typing import Any

from mirage.accessor.bin import BinAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.bin.read import read as _read
from mirage.core.bin.readdir import readdir as _readdir
from mirage.core.bin.refuse import refuse
from mirage.core.bin.stat import stat as _stat
from mirage.types import FileStat, PathSpec
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS


class BinViewVFS(BaseVFS):
    """Read-only view VFS backing the /usr/bin mount.

    Lists one executable file per program the session can run, rendered
    from the workspace's command lookup on every call; holds no storage
    of its own.

    Args:
        programs (Callable[[], list[str]]): every program name the
            session can run, sorted.
        note (Callable[[str], str | None]): the line one program's file
            says about it, None when the name runs as no program.
    """

    accessor: BinAccessor
    name = "bin"
    # A stub's size is its rendering: cheap, no network, never None.
    sizes_always_known: bool = True

    def __init__(
        self,
        programs: Callable[[], list[str]],
        note: Callable[[str], str | None],
    ) -> None:
        super().__init__()
        self.accessor = BinAccessor(programs, note)

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
        data = await _read(self.accessor, path, index)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    # What the view holds is the lookup's to say, so every write answers
    # as a read-only file system does, rather than as a missing function,
    # which would answer "Operation not supported".

    async def write(self, path: PathSpec, data: bytes) -> None:
        await refuse(self.accessor, path)

    async def append(
        self,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await refuse(self.accessor, path)

    async def pwrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        await refuse(self.accessor, path)

    async def create(self, path: PathSpec) -> None:
        await refuse(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await refuse(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await refuse(self.accessor, path)

    async def rmdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        await refuse(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        await refuse(self.accessor, src)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await refuse(self.accessor, path)

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
        await refuse(self.accessor, path)

    def get_state(self) -> dict[str, Any]:
        return {"type": self.name}
