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

from typing import Any

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine import place
from mirage.core.machine.capacity import capacity as _capacity
from mirage.core.machine.checksum import checksum as _checksum
from mirage.core.machine.copy import copy as _copy
from mirage.core.machine.copy import dir_copy as _dir_copy
from mirage.core.machine.create import create as _create
from mirage.core.machine.mkdir import mkdir as _mkdir
from mirage.core.machine.pwrite import pwrite as _pwrite
from mirage.core.machine.read import first_lines as _first_lines
from mirage.core.machine.read import last_lines as _last_lines
from mirage.core.machine.read import line_count as _line_count
from mirage.core.machine.read import read as _read
from mirage.core.machine.readdir import readdir as _readdir
from mirage.core.machine.rename import rename as _rename
from mirage.core.machine.rm import rm_r as _rm_r
from mirage.core.machine.rmdir import rmdir as _rmdir
from mirage.core.machine.search import files_containing as _files_containing
from mirage.core.machine.set_attrs import set_attrs as _set_attrs
from mirage.core.machine.stat import stat as _stat
from mirage.core.machine.stat import tree as _tree
from mirage.core.machine.truncate import truncate as _truncate
from mirage.core.machine.unlink import unlink as _unlink
from mirage.core.machine.write import write as _write
from mirage.errors.fs import enoent, exdev
from mirage.execution.machine.table import MachineTable
from mirage.io.types import ByteSource
from mirage.types import CapacityResult, FileStat, PathSpec, VFSName
from mirage.utils.path import norm
from mirage.vfs.base import BaseVFS
from mirage.vfs.constants import LOCAL_WALK_LIMIT
from mirage.vfs.machine.config import MachineVFSConfig


class MachineVFS(BaseVFS):
    """A machine's own files at a prefix, reached through the exec the
    workspace already holds for the machine: what its programs read and
    write, without serving or copying anything.

    On several machines each op picks where it acts: a name is read,
    removed or renamed on the machine holding it, a new name lands on the
    machine running the command's program, else on ``default_machine``,
    and a directory lists every machine's entries once. ``"@local"`` in a
    mount table is this VFS over every machine at the same path, so
    Mirage and a machine's programs name a file the same way.
    """

    accessor: MachineAccessor
    name: str = VFSName.MACHINE
    # Programs change these files behind Mirage's back.
    caches_reads: bool = False
    index_ttl: float = 0
    sizes_always_known: bool = True
    reads_ranges: bool = True
    walk_limit: int = LOCAL_WALK_LIMIT

    def __init__(self, config: MachineVFSConfig) -> None:
        super().__init__()
        self.config = config
        self.accessor = MachineAccessor(config)

    def bind_machines(self, machines: MachineTable, default: str) -> None:
        """Reach the workspace's machines once it has them.

        Args:
            machines (MachineTable): the workspace's machines.
            default (str): where a new name lands when the config names
                no ``default_machine``.
        """
        self.accessor.bind_machines(machines, default)

    def shows_own(self, machine: str, prefix: str) -> bool:
        """Whether the mount shows a machine its own files at the path
        they have there, so serving the prefix back to the machine would
        cover them.

        Args:
            machine (str): the machine's name.
            prefix (str): the mount's prefix.
        """
        return norm(self.config.root) == norm(prefix) and (
            machine in self.accessor.names()
        )

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await _readdir(self.accessor, self.accessor.names(), path)

    async def stat(self, path: PathSpec) -> FileStat:
        held = await place.holders(self.accessor, path)
        if not held:
            raise enoent(path)
        running = place.stage(self.accessor)
        return await _stat(
            self.accessor, running if running in held else held[0], path
        )

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> ByteSource:
        machine = await place.holder(self.accessor, path)
        return await _read(self.accessor, machine, path, offset, size)

    async def first_lines(self, path: PathSpec, n: int) -> bytes | None:
        machine = await place.holder(self.accessor, path)
        return await _first_lines(self.accessor, machine, path, n)

    async def last_lines(self, path: PathSpec, n: int) -> bytes | None:
        machine = await place.holder(self.accessor, path)
        return await _last_lines(self.accessor, machine, path, n)

    async def line_count(self, path: PathSpec) -> int | None:
        machine = await place.holder(self.accessor, path)
        return await _line_count(self.accessor, machine, path)

    async def checksum(self, path: PathSpec, algorithm: str) -> str | None:
        machine = await place.holder(self.accessor, path)
        return await _checksum(self.accessor, machine, path, algorithm)

    async def read_tree(self, path: PathSpec) -> dict[str, FileStat] | None:
        held = await place.holders(self.accessor, path)
        if not held:
            raise enoent(path)
        return await _tree(self.accessor, held, path)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        held = await place.holders(self.accessor, path)
        return await _files_containing(
            self.accessor, held, path, text, ignore_case
        )

    async def write(
        self, path: PathSpec, data: ByteSource, *, atomic: bool = False
    ) -> None:
        machine = await place.lands(self.accessor, path)
        await _write(self.accessor, machine, path, data, atomic=atomic)

    async def append(self, path: PathSpec, data: ByteSource) -> None:
        machine = await place.lands(self.accessor, path)
        await _write(self.accessor, machine, path, data, append=True)

    async def pwrite(self, path: PathSpec, data: bytes, offset: int) -> None:
        machine = await place.lands(self.accessor, path)
        await _pwrite(self.accessor, machine, path, data, offset)

    async def create(self, path: PathSpec) -> None:
        machine = await place.lands(self.accessor, path)
        await _create(self.accessor, machine, path)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        machine = await place.lands(self.accessor, path)
        await _truncate(self.accessor, machine, path, length, no_create)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        machine = await place.lands(self.accessor, path)
        await _mkdir(self.accessor, machine, path, parents)

    async def unlink(self, path: PathSpec) -> None:
        machine = await place.holder(self.accessor, path)
        await _unlink(self.accessor, machine, path)

    async def rmdir(self, path: PathSpec) -> None:
        for machine in await self._everywhere(path):
            await _rmdir(self.accessor, machine, path)

    async def rm_r(self, path: PathSpec) -> None:
        for machine in await self._everywhere(path):
            await _rm_r(self.accessor, machine, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        machine = await place.holder(self.accessor, src)
        several = len(self.accessor.names()) > 1
        await _rename(self.accessor, machine, src, dst, make_parent=several)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        machine = await self._same_machine(src, dst)
        await _copy(self.accessor, machine, src, dst)

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        machine = await self._same_machine(src, dst)
        await _dir_copy(self.accessor, machine, src, dst)

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
        machine = await place.holder(self.accessor, path)
        return await _set_attrs(
            self.accessor,
            machine,
            path,
            mode=mode,
            uid=uid,
            gid=gid,
            atime=atime,
            mtime=mtime,
        )

    async def capacity(self) -> CapacityResult:
        return await _capacity(
            self.accessor, PathSpec.from_str_path(self.config.root)
        )

    def storage_location(self) -> str:
        # The machines and the root pin the files, so two mounts of one
        # tree are known to share them.
        machines = ",".join(self.config.machines or ("*",))
        return f"{self.name}:{machines}:{self.config.root.rstrip('/') or '/'}"

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    async def _everywhere(self, path: PathSpec) -> list[str]:
        """The machines holding a directory, every one of which a removal
        reaches.

        Args:
            path (PathSpec): the directory.
        """
        held = await place.holders(self.accessor, path)
        if not held:
            raise enoent(path)
        return held

    async def _same_machine(self, src: PathSpec, dst: PathSpec) -> str:
        """The machine a copy runs on: the source's, when the copy lands
        there too; EXDEV otherwise, so the bytes move through Mirage as
        between two mounts.

        Args:
            src (PathSpec): the source.
            dst (PathSpec): the copy.
        """
        machine = await place.holder(self.accessor, src)
        if await place.lands(self.accessor, dst) != machine:
            raise exdev(dst)
        return machine
