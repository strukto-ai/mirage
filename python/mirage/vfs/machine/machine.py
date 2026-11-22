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
from mirage.core.machine.readdir import tree as _tree
from mirage.core.machine.rename import rename as _rename
from mirage.core.machine.rm import rm_r as _rm_r
from mirage.core.machine.rmdir import rmdir as _rmdir
from mirage.core.machine.search import files_containing as _files_containing
from mirage.core.machine.set_attrs import set_attrs as _set_attrs
from mirage.core.machine.stat import entry_stat as _entry_stat
from mirage.core.machine.stat import hidden_on as _hidden_on
from mirage.core.machine.stat import leaf as _leaf
from mirage.core.machine.stat import restricted as _restricted
from mirage.core.machine.stat import stat as _stat
from mirage.core.machine.truncate import truncate as _truncate
from mirage.core.machine.types import Holder
from mirage.core.machine.unlink import unlink as _unlink
from mirage.core.machine.utils import folder_of as _folder_of
from mirage.core.machine.write import write as _write
from mirage.errors.fs import eisdir, enoent, enotdir, enotempty, enotsup
from mirage.execution.machine.table import MachineTable
from mirage.io.types import ByteSource
from mirage.types import (
    CapacityResult,
    FileStat,
    PathSpec,
    VFSName,
)
from mirage.utils.path import norm
from mirage.vfs.base import BaseVFS
from mirage.vfs.constants import LOCAL_WALK_LIMIT
from mirage.vfs.machine.config import MachineVFSConfig


class MachineVFS(BaseVFS):
    """A machine's own files at a prefix, reached through the exec the
    workspace already holds for the machine: what its programs read and
    write, without serving or copying anything.

    Over several machines the mount shows one tree, as one machine would
    hold it. A name several machines hold is the copy written last, for
    every look at it and every change to it; a removal or a rename takes
    the name off every machine; a new name lands where its folder is, on
    the machine the command is about when that machine holds the folder;
    and a directory lists every machine's entries once. No file is copied
    between machines to keep them alike: a program opens its own
    machine's disk, whatever another machine holds. ``"@<machine>"`` in a
    mount table is this VFS over that machine at the same path, so Mirage
    and the machine's programs name a file the same way.
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
        hidden = await _hidden_on(self.accessor, path)
        own = place.kernel_view(self.accessor, path)
        machines = [
            m
            for m in self.accessor.names()
            if m not in hidden and own in (None, m)
        ]
        if not machines:
            raise enoent(path)
        return await _readdir(self.accessor, machines, path)

    def acts_on(self) -> str | None:
        if not self.accessor.bound:
            return None
        names = self.accessor.names()
        if len(names) == 1:
            return names[0]
        return place.command_machine(self.accessor)

    def filesystem(self) -> str:
        if not self.accessor.bound:
            return self.name
        machine = self.acts_on() or self.accessor.default_machine
        return f"{machine}:{self.config.root.rstrip('/') or '/'}"

    async def stat(self, path: PathSpec) -> FileStat:
        held = await place.holders(self.accessor, path)
        if not held:
            raise enoent(path)
        one = place.chosen(self.accessor, held)
        if one.entry is None:
            return await _stat(self.accessor, one.machine, path)
        return _entry_stat(_leaf(path), one.entry)

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
        if _restricted(path):
            return None
        held = await place.holders(self.accessor, path)
        if not held:
            raise enoent(path)
        return await _tree(self.accessor, [h.machine for h in held], path)

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if _restricted(path):
            return None
        held = await place.holders(self.accessor, path)
        return await _files_containing(
            self.accessor,
            [h.machine for h in held],
            path,
            text,
            ignore_case,
        )

    async def write(
        self, path: PathSpec, data: ByteSource, *, atomic: bool = False
    ) -> None:
        machine = await place.write_machine(self.accessor, path, replaces=True)
        await _write(self.accessor, machine, path, data, atomic=atomic)

    async def append(self, path: PathSpec, data: ByteSource) -> None:
        machine = await place.write_machine(self.accessor, path)
        await _write(self.accessor, machine, path, data, append=True)

    async def pwrite(self, path: PathSpec, data: bytes, offset: int) -> None:
        machine = await place.write_machine(self.accessor, path)
        await _pwrite(self.accessor, machine, path, data, offset)

    async def create(self, path: PathSpec) -> None:
        machine = await place.write_machine(self.accessor, path)
        await _create(self.accessor, machine, path)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        machine = await place.write_machine(self.accessor, path)
        await _truncate(self.accessor, machine, path, length, no_create)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        machine = await place.write_machine(
            self.accessor, path, parents=parents
        )
        await _mkdir(self.accessor, machine, path, parents)

    async def unlink(self, path: PathSpec) -> None:
        # Every machine's copy goes, or an older one would show again;
        # a folder another machine holds at the name is left alone.
        held = await self._everywhere(path)
        shown = place.chosen(self.accessor, held)
        await _unlink(self.accessor, shown.machine, path)
        for one in held:
            if one is not shown and not one.folder:
                await _unlink(self.accessor, one.machine, path)

    async def rmdir(self, path: PathSpec) -> None:
        held = await self._everywhere(path)
        shown = place.chosen(self.accessor, held)
        folders = [one.machine for one in held if one.folder]
        # Asked of every machine before any removes its copy, so a folder
        # one of them still fills is left whole on all of them.
        if (
            shown.folder
            and len(folders) > 1
            and await _readdir(self.accessor, folders, path)
        ):
            raise enotempty(path)
        await _rmdir(self.accessor, shown.machine, path)
        for one in held:
            if one is not shown and one.folder:
                await _rmdir(self.accessor, one.machine, path)

    async def rm_r(self, path: PathSpec) -> None:
        for one in await self._everywhere(path):
            await _rm_r(self.accessor, one.machine, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        held = await self._everywhere(src)
        moved = place.chosen(self.accessor, held)
        # A folder is renamed on every machine holding it, each keeping
        # its own entries; a file on the machine whose copy it is, the
        # other machines' copies of the old name going with it.
        movers = (
            [one.machine for one in held if one.folder]
            if moved.folder
            else [moved.machine]
        )
        several = len(self.accessor.names()) > 1
        there = await place.holders(self.accessor, dst) if several else []
        replaced = [one for one in there if one.machine not in movers]
        # Every machine's copy of the new name is judged before any
        # machine moves, so a refusal leaves the folder under one name.
        for one in there:
            if one.folder is not moved.folder:
                raise enotdir(dst) if moved.folder else eisdir(dst)
            if moved.folder and await _readdir(
                self.accessor, [one.machine], dst
            ):
                raise enotempty(dst)
        parents = (
            [
                one.machine
                for one in await place.holders(self.accessor, _folder_of(dst))
                if one.folder
            ]
            if several
            else []
        )
        for machine in movers:
            await _rename(
                self.accessor,
                machine,
                src,
                dst,
                make_parent=bool(parents) and machine not in parents,
            )
        for one in replaced:
            if moved.folder:
                await _rmdir(self.accessor, one.machine, dst)
            else:
                await _unlink(self.accessor, one.machine, dst)
        for one in held:
            if one.machine not in movers and not one.folder:
                await _unlink(self.accessor, one.machine, src)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        # A copy never crosses: it is made where the source is, and is
        # then the newest copy of its name.
        machine = await place.holder(self.accessor, src)
        await self._refuse_hidden(machine, dst)
        await _copy(
            self.accessor,
            machine,
            src,
            dst,
            make_parent=await self._lacks_folder(machine, dst),
        )
        if len(self.accessor.names()) == 1:
            return
        # The copy replaces the name, so another machine's copy of it
        # goes: one kept would show again once the new copy takes its
        # source's older time (``cp -p``).
        for one in await place.holders(self.accessor, dst):
            if one.machine != machine and not one.folder:
                await _unlink(self.accessor, one.machine, dst)

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        held = await self._everywhere(src)
        if len(held) > 1:
            # Each name under a folder several machines hold is copied
            # where it is, one by one, so each stays the copy it was.
            raise enotsup(self.name, "dir_copy", src)
        machine = held[0].machine
        await self._refuse_hidden(machine, dst)
        await _dir_copy(
            self.accessor,
            machine,
            src,
            dst,
            make_parent=await self._lacks_folder(machine, dst),
        )

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
            self.accessor,
            self.acts_on() or self.accessor.default_machine,
            PathSpec.from_str_path(self.config.root),
        )

    def storage_location(self) -> str:
        # The machines and the root pin the files, so two mounts of one
        # tree are known to share them.
        machines = ",".join(self.config.machines or ("*",))
        return f"{self.name}:{machines}:{self.config.root.rstrip('/') or '/'}"

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)

    async def _everywhere(self, path: PathSpec) -> list[Holder]:
        """The machines holding a name, every one of which a removal or a
        rename reaches.

        Args:
            path (PathSpec): the name.

        Raises:
            FileNotFoundError: no machine holds it.
        """
        held = await place.holders(self.accessor, path)
        if not held:
            raise enoent(path)
        return held

    async def _refuse_hidden(self, machine: str, path: PathSpec) -> None:
        """Refuse a name a machine's own links lead to one the session
        hides, before a program of the machine's writes through them.

        Args:
            machine (str): the machine the write runs on.
            path (PathSpec): the name written.

        Raises:
            FileNotFoundError: the name leads to a hidden one there.
        """
        if machine in await _hidden_on(self.accessor, path):
            raise enoent(path)

    async def _lacks_folder(self, machine: str, path: PathSpec) -> bool:
        """Whether a new name's folder is on other machines only, so the
        machine the name lands on makes the folder first.

        Args:
            machine (str): the machine the name lands on.
            path (PathSpec): the new name.
        """
        if len(self.accessor.names()) == 1:
            return False
        folders = [
            one.machine
            for one in await place.holders(self.accessor, _folder_of(path))
            if one.folder
        ]
        return bool(folders) and machine not in folders
