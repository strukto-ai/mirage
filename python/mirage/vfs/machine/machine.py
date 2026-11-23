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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine import place
from mirage.core.machine.capacity import capacity as _capacity
from mirage.core.machine.checksum import checksum as _checksum
from mirage.core.machine.copy import copy as _copy
from mirage.core.machine.copy import copy_from as _copy_from
from mirage.core.machine.copy import dir_copy as _dir_copy
from mirage.core.machine.create import create as _create
from mirage.core.machine.mkdir import mkdir as _mkdir
from mirage.core.machine.pwrite import pwrite as _pwrite
from mirage.core.machine.read import first_lines as _first_lines
from mirage.core.machine.read import last_lines as _last_lines
from mirage.core.machine.read import line_count as _line_count
from mirage.core.machine.read import read as _read
from mirage.core.machine.read import read_stream as _read_stream
from mirage.core.machine.readdir import readdir as _readdir
from mirage.core.machine.readdir import tree as _tree
from mirage.core.machine.rename import rename as _rename
from mirage.core.machine.rm import rm_r as _rm_r
from mirage.core.machine.rmdir import rmdir as _rmdir
from mirage.core.machine.search import files_containing as _files_containing
from mirage.core.machine.set_attrs import set_attrs as _set_attrs
from mirage.core.machine.stat import has_hides as _has_hides
from mirage.core.machine.stat import holder_stat as _holder_stat
from mirage.core.machine.stat import stat as _stat
from mirage.core.machine.truncate import truncate as _truncate
from mirage.core.machine.unlink import unlink as _unlink
from mirage.core.machine.utils import leaf as _leaf
from mirage.core.machine.write import write as _write
from mirage.errors.fs import (
    eisdir,
    enoent,
    enotdir,
    enotempty,
    enotsup,
    exdev,
)
from mirage.execution.machine.table import MachineTable
from mirage.io.stream import close_quietly
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

logger = logging.getLogger(__name__)


async def _refuse_landing(
    accessor: MachineAccessor, machine: str, path: PathSpec, data: ByteSource
) -> None:
    """Refuse bytes landing on a machine they may not go to
    (``place.refuse_crossing``), closing what would have been written
    so its writer stops.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine the write lands on.
        path (PathSpec): the file.
        data (ByteSource): what would have been written.

    Raises:
        PermissionError: the bytes come from another machine.
    """
    try:
        place.refuse_crossing(accessor, machine, path)
    except PermissionError:
        await close_quietly(data)
        raise


async def _unlink_older(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> None:
    """Take an older copy of a name off a machine; one already gone, which
    another settling took first, is no error.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine holding the copy.
        path (PathSpec): the name.
    """
    try:
        await _unlink(accessor, machine, path)
    except FileNotFoundError as exc:
        logger.debug("%s already gone from %s: %s", path.virtual, machine, exc)


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
        self._live_writes: dict[str, list[str]] = {}
        self._latest: dict[str, tuple[int, str]] = {}
        self._landings = 0
        self._settling: dict[str, int] = {}
        self._unsettled: set[str] = set()

    @asynccontextmanager
    async def _live_write(
        self, machine: str, path: PathSpec, *, replaces: bool
    ) -> AsyncIterator[None]:
        """Count a write of a name on a machine as live while it lands,
        and end it (``_end_write``).

        Args:
            machine (str): the machine written.
            path (PathSpec): the name.
            replaces (bool): the write replaces the name, so once it lands
                no other machine's copy of it stays.
        """
        self._live_writes.setdefault(path.virtual, []).append(machine)
        try:
            yield
        except BaseException:
            await self._end_write(
                machine, path, landed=False, replaces=replaces
            )
            raise
        await self._end_write(machine, path, landed=True, replaces=replaces)

    async def _end_write(
        self, machine: str, path: PathSpec, *, landed: bool, replaces: bool
    ) -> None:
        """End a live write of a name. One that landed is the name's latest
        copy, noted while the name has other writes to settle with
        (``_latest``). One that replaces the name settles it
        (``_settle``), and so does the last write of an unsettled name to
        end, a failed one too, so once the writes end one copy shows, the
        newest.

        Args:
            machine (str): the machine written.
            path (PathSpec): the name.
            landed (bool): the write landed; a failed one leaves the
                copies of those that did.
            replaces (bool): the write replaces the name.
        """
        key = path.virtual
        live = self._live_writes[key]
        live.remove(machine)
        if not live:
            del self._live_writes[key]
        if landed and (
            replaces or live or key in self._unsettled or key in self._settling
        ):
            self._landings += 1
            self._latest[key] = (self._landings, machine)
        if not (landed and replaces) and (live or key not in self._unsettled):
            self._forget(key)
            return
        if not live:
            self._unsettled.discard(key)
        try:
            await self._settle(path)
        except Exception as exc:
            if landed:
                raise
            logger.debug("older copies of %s kept: %s", key, exc)

    async def _settle(self, path: PathSpec) -> None:
        """Take a name off every machine but the one its latest write
        landed on (``_latest``), so one copy shows, the newest. The latest
        is looked up again before every removal, and a write landing
        meanwhile makes the look start over with its copy kept. A machine
        still writing the name keeps its copy and leaves the name
        unsettled, for the last write of it to settle (``_end_write``).

        Args:
            path (PathSpec): the name.
        """
        key = path.virtual
        self._settling[key] = self._settling.get(key, 0) + 1
        try:
            while self.accessor.several and (seen := self._latest.get(key)):
                for one in await place.holders(self.accessor, path):
                    if self._latest.get(key) != seen:
                        break
                    if one.machine == seen[1] or one.is_folder:
                        continue
                    if one.machine in self._live_writes.get(key, ()):
                        self._unsettled.add(key)
                        continue
                    await _unlink_older(self.accessor, one.machine, path)
                if self._latest.get(key) == seen:
                    return
        finally:
            self._settling[key] -= 1
            if not self._settling[key]:
                del self._settling[key]
            self._forget(key)

    def _forget(self, key: str) -> None:
        """Let go of a name's latest landing once nothing writes or settles
        it.

        Args:
            key (str): the name.
        """
        if (
            key not in self._live_writes
            and key not in self._unsettled
            and key not in self._settling
        ):
            self._latest.pop(key, None)

    async def _land_at_origin(
        self, machine: str, path: PathSpec, data: ByteSource, atomic: bool
    ) -> None:
        """Land a whole file on the machine its bytes come from
        (``place.origin_machine``: a program's ``>``, or a copy made by a
        read and a write) as a direct copy lands (``copy_from``): its
        folder made there when only another machine holds it; the other
        machines' copies of the name go once it lands (``_end_write``).

        Args:
            machine (str): the machine the bytes come from.
            path (PathSpec): the file.
            data (ByteSource): its bytes.
            atomic (bool): show nothing until the bytes have ended whole.
        """
        try:
            lacking = await place.machines_lacking_folder(
                self.accessor, [machine], path
            )
        except BaseException:
            await close_quietly(data)
            raise
        await _write(
            self.accessor,
            machine,
            path,
            data,
            atomic=atomic,
            make_parent=bool(lacking),
        )

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
        machines = await place.asked_machines(self.accessor, path)
        if not machines:
            raise enoent(path)
        return await _readdir(self.accessor, machines, path)

    def call_machine(self) -> str | None:
        if not self.accessor.bound:
            return None
        if not self.accessor.several:
            return self.accessor.default_machine
        return place.command_machine(self.accessor)

    def filesystem(self) -> str:
        if not self.accessor.bound:
            return self.name
        machine = self.call_machine() or self.accessor.default_machine
        return f"{machine}:{self.config.root.rstrip('/') or '/'}"

    async def stat(self, path: PathSpec) -> FileStat:
        held = await place.existing_holders(self.accessor, path)
        one = place.chosen(self.accessor, held)
        if one.entry is None:
            return await _stat(self.accessor, one.machine, path)
        return _holder_stat(_leaf(path), one)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> ByteSource:
        """A file's bytes from the machine holding it; a whole file as a
        stream, never held whole, where the machine's output can be read
        as it comes. A program the line runs on another machine never
        reads it (``place.refuse_crossing``).

        Args:
            path (PathSpec): the file.
            offset (int): the first byte.
            size (int | None): how many bytes; None for the rest.
        """
        machine = await place.holding_machine(self.accessor, path)
        place.refuse_crossing(self.accessor, machine, path, reads=True)
        place.note_copy_source(machine)
        if not offset and size is None and self.accessor.streams(machine):
            return _read_stream(self.accessor, machine, path)
        return await _read(self.accessor, machine, path, offset, size)

    async def first_lines(self, path: PathSpec, n: int) -> bytes | None:
        machine = await place.holding_machine(self.accessor, path)
        return await _first_lines(self.accessor, machine, path, n)

    async def last_lines(self, path: PathSpec, n: int) -> bytes | None:
        machine = await place.holding_machine(self.accessor, path)
        return await _last_lines(self.accessor, machine, path, n)

    async def line_count(self, path: PathSpec) -> int | None:
        machine = await place.holding_machine(self.accessor, path)
        return await _line_count(self.accessor, machine, path)

    async def checksum(self, path: PathSpec, algorithm: str) -> str | None:
        machine = await place.holding_machine(self.accessor, path)
        return await _checksum(self.accessor, machine, path, algorithm)

    async def read_tree(self, path: PathSpec) -> dict[str, FileStat] | None:
        if _has_hides(path):
            return None
        held = await place.existing_holders(self.accessor, path)
        shown = await _tree(self.accessor, [h.machine for h in held], path)
        if shown is None:
            return None
        return {
            rel: _holder_stat(rel.rsplit("/", 1)[-1], one)
            for rel, one in shown.items()
        }

    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        if _has_hides(path):
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
        await _refuse_landing(self.accessor, machine, path, data)
        origin = place.origin_machine(self.accessor) == machine
        async with self._live_write(machine, path, replaces=origin):
            if origin:
                await self._land_at_origin(machine, path, data, atomic)
            else:
                await _write(self.accessor, machine, path, data, atomic=atomic)

    async def append(self, path: PathSpec, data: ByteSource) -> None:
        machine = await place.write_machine(self.accessor, path)
        await _refuse_landing(self.accessor, machine, path, data)
        async with self._live_write(machine, path, replaces=False):
            await _write(self.accessor, machine, path, data, append=True)

    async def pwrite(self, path: PathSpec, data: bytes, offset: int) -> None:
        machine = await place.write_machine(self.accessor, path)
        place.refuse_crossing(self.accessor, machine, path)
        await _pwrite(self.accessor, machine, path, data, offset)

    async def create(self, path: PathSpec) -> None:
        machine = await place.write_machine(self.accessor, path)
        place.refuse_crossing(self.accessor, machine, path)
        await _create(self.accessor, machine, path)

    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        machine = await place.write_machine(self.accessor, path)
        place.refuse_crossing(self.accessor, machine, path)
        await _truncate(self.accessor, machine, path, length, no_create)

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        machine = await place.write_machine(
            self.accessor, path, parents=parents
        )
        await _mkdir(self.accessor, machine, path, parents)

    async def unlink(self, path: PathSpec) -> None:
        """Remove a file from every machine holding it, or an older copy
        would show again; a folder another machine holds at the name is
        left alone.

        Args:
            path (PathSpec): the file.
        """
        held = await place.existing_holders(self.accessor, path)
        shown = place.chosen(self.accessor, held)
        await _unlink(self.accessor, shown.machine, path)
        for one in held:
            if one is not shown and not one.is_folder:
                await _unlink(self.accessor, one.machine, path)

    async def rmdir(self, path: PathSpec) -> None:
        """Remove an empty folder from every machine holding it. Every
        machine is asked before any removes its copy, so a folder one of
        them still fills is left whole on all of them.

        Args:
            path (PathSpec): the folder.
        """
        held = await place.existing_holders(self.accessor, path)
        shown = place.chosen(self.accessor, held)
        folders = [one.machine for one in held if one.is_folder]
        if (
            shown.is_folder
            and len(folders) > 1
            and await _readdir(self.accessor, folders, path)
        ):
            raise enotempty(path)
        await _rmdir(self.accessor, shown.machine, path)
        for one in held:
            if one is not shown and one.is_folder:
                await _rmdir(self.accessor, one.machine, path)

    async def rm_r(self, path: PathSpec) -> None:
        for one in await place.existing_holders(self.accessor, path):
            await _rm_r(self.accessor, one.machine, path)

    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        """Rename a name where it is. A folder is renamed on every
        machine holding it, each keeping its own entries; a file on the
        machine whose copy is shown, the other machines' copies of the
        old name going with it. Every machine's copy of the new name is
        judged before any machine moves, so a refusal leaves the folder
        under one name.

        Args:
            src (PathSpec): the name as it is.
            dst (PathSpec): the new name.
        """
        held = await place.existing_holders(self.accessor, src)
        moved = place.chosen(self.accessor, held)
        movers = (
            [one.machine for one in held if one.is_folder]
            if moved.is_folder
            else [moved.machine]
        )
        several = self.accessor.several
        there = await place.holders(self.accessor, dst) if several else []
        replaced = [one for one in there if one.machine not in movers]
        for one in there:
            if one.is_folder is not moved.is_folder:
                raise enotdir(dst) if moved.is_folder else eisdir(dst)
            if moved.is_folder and await _readdir(
                self.accessor, [one.machine], dst
            ):
                raise enotempty(dst)
        lacking = await place.machines_lacking_folder(
            self.accessor, movers, dst
        )
        for machine in movers:
            await _rename(
                self.accessor,
                machine,
                src,
                dst,
                make_parent=machine in lacking,
            )
        for one in replaced:
            if moved.is_folder:
                await _rmdir(self.accessor, one.machine, dst)
            else:
                await _unlink(self.accessor, one.machine, dst)
        for one in held:
            if one.machine not in movers and not one.is_folder:
                await _unlink(self.accessor, one.machine, src)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        """Copy a file on the machine holding it: a copy never crosses,
        and is then the newest copy of its name. It replaces the name,
        so another machine's copy of it goes: one kept would show again
        once the new copy takes its source's older time (``cp -p``).

        Args:
            src (PathSpec): the file.
            dst (PathSpec): the copy's name.
        """
        machine = await place.holding_machine(self.accessor, src)
        await place.refuse_hidden(self.accessor, machine, dst)
        lacking = await place.machines_lacking_folder(
            self.accessor, [machine], dst
        )
        async with self._live_write(machine, dst, replaces=True):
            await _copy(
                self.accessor, machine, src, dst, make_parent=bool(lacking)
            )

    async def copy_from(
        self, source: BaseVFS, src: PathSpec, dst: PathSpec
    ) -> None:
        """Copy a file another machine mount shows, on the machine
        holding it, when this mount shows that machine too: the copy
        lands where its source is and its bytes never leave the machine
        (``cp /srv/a/out /tmp/out``), replacing the name as ``copy``
        does. A file of a machine this mount does not show is refused:
        bytes go between a machine and a store, never from one machine to
        another. A store's file is EXDEV, and its bytes come through
        Mirage.

        Args:
            source (BaseVFS): the source mount's VFS.
            src (PathSpec): the file, on ``source``.
            dst (PathSpec): the copy, on this mount.

        Raises:
            OSError: EXDEV for a source that is no machine's file.
            PermissionError: the source is a machine this mount does not
                show.
        """
        if not isinstance(source, MachineVFS):
            raise exdev(dst)
        machine = await place.holding_machine(source.accessor, src)
        if machine not in self.accessor.names():
            target = await place.write_machine(
                self.accessor, dst, replaces=True
            )
            raise place.crossing_refused(machine, target, dst)
        await place.refuse_hidden(self.accessor, machine, dst)
        lacking = await place.machines_lacking_folder(
            self.accessor, [machine], dst
        )
        async with self._live_write(machine, dst, replaces=True):
            await _copy_from(
                source.accessor,
                self.accessor,
                machine,
                src,
                dst,
                make_parent=bool(lacking),
            )

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        """Copy a folder one machine holds, on that machine. A folder
        several machines hold is refused, so each name under it is
        copied where it is, one by one, and stays the copy it was.

        Args:
            src (PathSpec): the folder.
            dst (PathSpec): the copy's name.
        """
        held = await place.existing_holders(self.accessor, src)
        if len(held) > 1:
            raise enotsup(self.name, "dir_copy", src)
        machine = held[0].machine
        await place.refuse_hidden(self.accessor, machine, dst)
        lacking = await place.machines_lacking_folder(
            self.accessor, [machine], dst
        )
        await _dir_copy(
            self.accessor, machine, src, dst, make_parent=bool(lacking)
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
        machine = await place.holding_machine(self.accessor, path)
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
            self.call_machine() or self.accessor.default_machine,
            PathSpec.from_str_path(self.config.root),
        )

    def storage_location(self) -> str:
        # The machines and the root pin the files, so two mounts of one
        # tree are known to share them.
        machines = ",".join(self.config.machines or ("*",))
        return f"{self.name}:{machines}:{self.config.root.rstrip('/') or '/'}"

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
