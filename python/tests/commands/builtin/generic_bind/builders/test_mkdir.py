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

import pytest

from mirage.errors.fs import eacces
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


class _Unattributed(RAMVFS):
    """A RAM store with no setattr and no directory times, as an object
    store is: a mode and a made directory's time land in the overlay."""

    setattr = BaseVFS.setattr

    async def stat(self, path: PathSpec) -> FileStat:
        row = await super().stat(path)
        if row.type is FileType.DIRECTORY:
            return row.model_copy(update={"modified": None})
        return row


class _Unkept(_Unattributed):
    """A store that keeps no empty directory, as hf does: mkdir succeeds
    and makes nothing until a key lands below."""

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        return None


class _Halting(_Unattributed):
    """A store whose ``-p`` chain stops after its first directory, as
    one whose second marker write is refused does."""

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        if not parents:
            return await super().mkdir(path, parents)
        self._store.dirs.add("/p")
        raise eacces(path)


class _Unanswering(_Halting):
    """A store that stops answering stat once its chain has failed."""

    failed = False

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        try:
            return await super().mkdir(path, parents)
        finally:
            self.failed = parents

    async def stat(self, path: PathSpec) -> FileStat:
        if self.failed:
            raise RuntimeError("stat stopped answering")
        return await super().stat(path)


@pytest.mark.asyncio
async def test_a_mode_lands_where_a_chmod_would():
    ws = Workspace({"/d": _Unattributed()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "mkdir -p -m 700 /d/a/kid && (umask 077; mkdir /d/m) && "
            "stat -c '%n %a' /d/a /d/a/kid /d/m"
        )
        assert (result.exit_code, result.stdout) == (
            0,
            b"/d/a 755\n/d/a/kid 700\n/d/m 700\n",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_every_directory_parents_makes_takes_its_time():
    ws = Workspace({"/d": _Unattributed()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "touch -d 2000-01-01 /d/ref && mkdir -p /d/p/a/b && "
            "find /d/p -newer /d/ref | sort"
        )
        assert (result.exit_code, result.stdout) == (
            0,
            b"/d/p\n/d/p/a\n/d/p/a/b\n",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("vfs", [RAMVFS, _Unattributed])
async def test_parents_leaves_an_existing_directory_its_mode(vfs):
    ws = Workspace({"/d": vfs()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "mkdir /d/e && chmod 750 /d/e && (umask 077; mkdir -p /d/e) && "
            "mkdir -p -m 700 /d/e && stat -c %a /d/e"
        )
        assert (result.exit_code, result.stdout) == (0, b"750\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_store_keeping_no_empty_directory_takes_a_mask():
    ws = Workspace({"/d": _Unkept()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "(umask 077; mkdir -p /d/new) && mkdir -m 700 /d/other && echo ok"
        )
        assert (result.exit_code, result.stdout) == (0, b"ok\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_chain_that_fails_partway_times_what_it_made():
    ws = Workspace({"/d": _Halting()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "touch -d 2000-01-01 /d/ref; mkdir -p /d/p/a/b; echo rc=$?; "
            "find /d/p -newer /d/ref"
        )
        assert result.stdout == b"rc=1\n/d/p\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["mkdir -p -m 700 {}", "(umask 077; mkdir -p {})"]
)
async def test_a_bad_operand_leaves_the_next_one_made(line):
    ws = Workspace({"/d": _Unattributed()}, mode=MountMode.WRITE)
    try:
        await ws.shell("touch /d/file")
        result = await ws.shell(line.format("/d/file/sub /d/good"))
        assert (result.exit_code, result.stderr) == (
            1,
            b"mkdir: cannot create directory '/d/file': Not a directory\n",
        )
        mode = await ws.shell("stat -c %a /d/good")
        assert mode.stdout == b"700\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_create_error_outlives_timing_cleanup():
    ws = Workspace({"/d": _Unanswering()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell("mkdir -p /d/p/a/b")
        assert (result.exit_code, result.stderr) == (
            1,
            b"mkdir: cannot create directory '/d/p/a/b': Permission denied\n",
        )
    finally:
        await ws.close()
