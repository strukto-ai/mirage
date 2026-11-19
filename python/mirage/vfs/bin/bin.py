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

import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

from mirage.accessor.bin import BinAccessor
from mirage.core.bin.read import read as _read
from mirage.core.bin.readdir import readdir as _readdir
from mirage.core.bin.refuse import refuse
from mirage.core.bin.stat import stat as _stat
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource
from mirage.types import DirListing, FileStat, PathSpec
from mirage.utils.dates import now_iso
from mirage.vfs.base import BaseVFS

logger = logging.getLogger(__name__)


class BinViewVFS(BaseVFS):
    """Read-only view VFS backing the /usr/bin mount.

    Lists one executable file per program Mirage runs, rendered from the
    workspace's command lookup on every call; holds no storage of its
    own. A name it leaves to what lies under it (one a machine runs, or
    none of Mirage's) is the file the mount beneath shows at that path:
    with a machine's disk at ``/``, ``/usr/bin/python3`` is the
    machine's own file and ``/usr/bin/grep`` Mirage's. Where nothing
    lies beneath, a program a machine runs keeps its file here.

    Args:
        programs (Callable[[], list[str]]): every program name the
            session can run, sorted.
        note (Callable[[str], str | None]): the line one program's file
            says about it, None when the name runs as no program.
        leaves (Callable[[str], bool] | None): whether the view leaves a
            name to the mount beneath; None leaves none.
        beneath (Callable[[str], tuple[BaseVFS, PathSpec] | None] | None):
            the mount beneath the view and the path in it, for a
            virtual path under the view; None when nothing lies there.
    """

    accessor: BinAccessor
    name = "bin"
    # A stub's size is its rendering: cheap, no network, never None.
    sizes_always_known: bool = True

    def __init__(
        self,
        programs: Callable[[], list[str]],
        note: Callable[[str], str | None],
        leaves: Callable[[str], bool] | None = None,
        beneath: (
            Callable[[str], tuple[BaseVFS, PathSpec] | None] | None
        ) = None,
    ) -> None:
        super().__init__()
        self.accessor = BinAccessor(programs, note, now_iso())
        self._leaves = leaves
        self._beneath = beneath

    def leaves(self, name: str) -> bool:
        """Whether the view leaves ``name`` to the mount beneath it: a
        program a machine runs, or a name none of Mirage's layers runs.

        Args:
            name (str): a name under the view.
        """
        return (
            self._leaves is not None and "/" not in name and self._leaves(name)
        )

    def _below(self, path: PathSpec) -> tuple[BaseVFS, PathSpec] | None:
        key = path.mount_path.strip("/")
        if self._beneath is None or (key and not self.leaves(key)):
            return None
        return self._beneath(path.virtual)

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        mine = await _readdir(self.accessor, path)
        below = self._below(path)
        if below is None:
            return mine
        vfs, spec = below
        try:
            listed = await vfs.readdir(spec)
        except FS_ERRORS:
            logger.debug("nothing beneath %s", path.virtual, exc_info=True)
            return mine
        theirs = listed.entries if isinstance(listed, DirListing) else listed
        held = {row.name for row in theirs if self.leaves(row.name)}
        kept = [row for row in mine if row.name not in held]
        named = {row.name for row in kept}
        rows = kept + [
            row
            for row in theirs
            if row.name not in named and self.leaves(row.name)
        ]
        return sorted(rows, key=lambda row: row.name)

    async def read(self, path: PathSpec) -> ByteSource:
        below = self._below(path)
        if below is not None and path.mount_path.strip("/"):
            vfs, spec = below
            try:
                await vfs.stat(spec)
            except FileNotFoundError:
                logger.debug("%s: none beneath", path.virtual)
            else:
                found = vfs.read(spec)
                return (
                    found if isinstance(found, AsyncIterator) else await found
                )
        return await _read(self.accessor, path)

    async def stat(self, path: PathSpec) -> FileStat:
        below = self._below(path)
        if below is not None and path.mount_path.strip("/"):
            vfs, spec = below
            try:
                return await vfs.stat(spec)
            except FileNotFoundError:
                logger.debug("%s: none beneath", path.virtual)
        return await _stat(self.accessor, path)

    # What the view holds is the lookup's to say, so every write answers
    # as a read-only file system does, rather than as a missing function,
    # which would answer "Operation not supported".

    async def write(self, path: PathSpec, data: ByteSource) -> None:
        await refuse(self.accessor, path)

    async def append(self, path: PathSpec, data: ByteSource) -> None:
        await refuse(self.accessor, path)

    async def pwrite(self, path: PathSpec, data: bytes, offset: int) -> None:
        await refuse(self.accessor, path)

    async def create(self, path: PathSpec) -> None:
        await refuse(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await refuse(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        await refuse(self.accessor, path)

    async def rmdir(self, path: PathSpec) -> None:
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
