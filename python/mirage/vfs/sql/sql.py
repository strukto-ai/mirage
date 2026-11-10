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

import weakref
from contextlib import AbstractAsyncContextManager
from functools import partial
from typing import Any

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.capacity import count as _count
from mirage.core.sql.capacity import size_of as _size_of
from mirage.core.sql.copy import copy as _copy
from mirage.core.sql.create import create as _create
from mirage.core.sql.exists import exists as _exists
from mirage.core.sql.mkdir import mkdir as _mkdir
from mirage.core.sql.read import read as _read
from mirage.core.sql.readdir import readdir as _readdir
from mirage.core.sql.readdir import tree as _tree
from mirage.core.sql.rename import rename as _rename
from mirage.core.sql.rm import rm_r as _rm_r
from mirage.core.sql.rmdir import rmdir as _rmdir
from mirage.core.sql.snapshot import restore, snapshot
from mirage.core.sql.stat import stat as _stat
from mirage.core.sql.stream import read_stream as _read_stream
from mirage.core.sql.truncate import truncate as _truncate
from mirage.core.sql.unlink import unlink as _unlink
from mirage.core.sql.write import write as _write
from mirage.errors.types import QuotaExceededError
from mirage.io.types import ByteSource
from mirage.types import (
    CapacityResult,
    CapacityState,
    FileStat,
    PathSpec,
    VFSName,
)
from mirage.vfs.base import BaseVFS
from mirage.vfs.capacity import Charge, StorageUsage, charge, storage_usage
from mirage.vfs.sql.driver import SqliteDriver
from mirage.vfs.sql.types import SqlDriver

# The usages of the mounts on one driver, by limit. Each counts every
# file of the database, so mounts with one limit count against one usage
# and their writes together stay within it.
_shared: weakref.WeakKeyDictionary[SqlDriver, dict[int, StorageUsage]] = (
    weakref.WeakKeyDictionary()
)


def _shared_usage(
    name: str, driver: SqlDriver, capacity: int | str | None
) -> StorageUsage | None:
    usage = storage_usage(name, capacity)
    if usage is None:
        return None
    by_limit = _shared.setdefault(driver, {})
    return by_limit.setdefault(usage.limit, usage)


class SqlVFS(BaseVFS):
    """A filesystem kept in SQL tables, over whatever driver it is given.

    The tables are laid out as AgentFS's: an inode per file and
    directory, an entry naming each under its parent, and a file's bytes
    in rows of the database's chunk size. Each op resolves its path in
    one query and lands its change in one transaction. A mount serves one
    folder of its database (``/``, all of it, by default), so several
    mounts can share one database. Mirrors TypeScript's ``SqlVFS``.
    """

    name: str = VFSName.SQL
    accessor: SqlAccessor
    # byte store: stat() sizes every file from metadata
    sizes_always_known: bool = True
    index_ttl: float = 0

    reads_ranges: bool = True
    local: bool = True

    def __init__(
        self,
        path: str | None = None,
        capacity: int | str | None = None,
        *,
        driver: SqlDriver | None = None,
        root: str = "/",
    ) -> None:
        """Args:
        path (str | None): the SQLite file the mount lives in, opened and
            closed with the mount; None keeps it in this process
            (``:memory:``).
        capacity (int | str | None): the most bytes the database's files
            may hold, whichever folder they are in, a size like
            ``100MB`` or a count of bytes; None for no limit. Mounts
            handed one driver with one capacity share it. Counted at the
            first write or ``df``; a writer in another process is
            counted at the next ``df``.
        driver (SqlDriver | None): a database to borrow instead of a
            file; the caller closes it.
        root (str): the folder of the database the mount serves, made
            with its parents on the first op when missing; ``/`` for all
            of it.

        Raises:
            ValueError: when both ``path`` and ``driver`` are given.
        """
        if path is not None and driver is not None:
            raise ValueError("SqlVFS takes a path or a driver, not both")
        super().__init__()
        self._owns_driver = driver is None
        opened = (
            driver if driver is not None else SqliteDriver(path or ":memory:")
        )
        self.accessor = SqlAccessor(opened, root)
        self.usage = _shared_usage(self.name, opened, capacity)

    def _charge(self, path: PathSpec) -> AbstractAsyncContextManager[Charge]:
        return charge(
            self.usage,
            path,
            partial(_size_of, self.accessor),
            partial(_count, self.accessor),
        )

    def storage_location(self) -> str:
        # The folder joins the location, so a file reads as one key
        # through every mount on the database, as ``/`` and its folder
        # ``/a`` name ``/a/x`` and ``/x``.
        root = self.accessor.root
        folder = "" if root == "/" else root
        return f"{self.name}:{self.accessor.driver.location}{folder}"

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await _readdir(self.accessor, path)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> ByteSource:
        if not offset and size is None:
            return _read_stream(self.accessor, path)
        return await _read(self.accessor, path, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await _stat(self.accessor, path)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    async def read_tree(
        self,
        path: PathSpec,
    ) -> dict[str, FileStat] | None:
        return await _tree(self.accessor, path)

    async def write(
        self, path: PathSpec, data: ByteSource, *, atomic: bool = False
    ) -> None:
        async with self._charge(path) as held:
            await _write(self.accessor, path, held.stream(data), atomic=atomic)

    async def append(self, path: PathSpec, data: ByteSource) -> None:
        async with self._charge(path) as held:
            await _write(
                self.accessor,
                path,
                held.stream(data, append=True),
                append=True,
            )

    async def create(self, path: PathSpec) -> None:
        async with self._charge(path):
            await _create(self.accessor, path)

    async def unlink(self, path: PathSpec) -> None:
        async with self._charge(path):
            await _unlink(self.accessor, path)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        await _mkdir(self.accessor, path, parents=parents)

    async def rmdir(self, path: PathSpec) -> None:
        await _rmdir(self.accessor, path)

    async def rm_r(self, path: PathSpec) -> Any:
        async with self._charge(path):
            return await _rm_r(self.accessor, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        async with self._charge(src), self._charge(dst):
            await _rename(self.accessor, src, dst)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        async with self._charge(dst) as held:
            if self.usage is not None:
                held.grow_to(await _size_of(self.accessor, src))
            await _copy(self.accessor, src, dst)
            if self.usage is not None:
                copied = await _size_of(self.accessor, dst)
                try:
                    held.grow_to(copied)
                except QuotaExceededError:
                    await _truncate(self.accessor, dst, held.reserved, True)
                    raise

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        async with self._charge(path) as held:
            if not no_create or await self.exists(path):
                held.grow_to(length)
            await _truncate(self.accessor, path, length, no_create)

    async def capacity(self) -> CapacityResult:
        """The database's quota when capped, counted afresh so a writer
        in another process shows; else a database that grows (ELASTIC).
        Mirrors TypeScript's."""
        if self.usage is None:
            return CapacityResult(state=CapacityState.ELASTIC)
        self.usage.stale()
        await self.usage.counted(partial(_count, self.accessor))
        return self.usage.report()

    def get_state(self) -> dict[str, Any]:
        return {
            "type": self.name,
            "config": (
                {"capacity": self.usage.limit}
                if self.usage is not None
                else {}
            ),
            **snapshot(self.accessor),
        }

    def load_state(self, state: dict[str, Any]) -> None:
        restore(
            self.accessor,
            files=state.get("files", {}),
            dirs=state.get("dirs", ["/"]),
            modified=state.get("modified", {}),
        )
        if self.usage is not None:
            self.usage.stale()

    async def close(self) -> None:
        if self._closed:
            return
        if self._owns_driver:
            self.accessor.driver.close()
        await super().close()
