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

from mirage.cache.index.scope import command_scope, command_started
from mirage.commands.builtin.generic.du import TRUNCATED_NOTE
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.errors.fs import eacces
from mirage.io import IOResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import install, replaces


@pytest.mark.asyncio
async def test_output_is_read_inside_the_running_command():
    # A fresh mount trusts only the listings the running command made, so
    # a walk read lazily after the command ended was served stale ones.
    seen: list[int | None] = []

    async def fn(ops, accessor, paths, texts, opts):
        async def walk():
            seen.append(command_started())
            yield b"hit\n"

        return walk(), IOResult()

    async def dispatch(op, path, **kwargs):
        raise AssertionError(op)

    async with command_scope():
        started = command_started()
        stdout, _ = await run_dispatch(
            GenericCommand("grep", fn), [], [], {}, dispatch, "/"
        )
    assert (stdout, seen) == (b"hit\n", [started])


@pytest.mark.asyncio
@pytest.mark.parametrize("overwrite", [False, True])
async def test_relay_sort_caches_inputs_and_replacements(overwrite):
    left, right = RAMVFS(), RAMVFS()
    left.caches_reads = right.caches_reads = True
    left.load_state({"files": {"/input": b"z\na\n"}})
    right.load_state({"files": {"/input": b"m\n"}})
    ws = Workspace({"/a": left, "/b": right}, mode=MountMode.WRITE)
    command = "sort /a/input /b/input"
    try:
        result = await ws.shell(
            command + (" -o /a/input" if overwrite else "")
        )
        assert result.exit_code == 0
        assert await result.materialize_stdout() == (
            b"" if overwrite else b"a\nm\nz\n"
        )
        assert await ws.cache.get("/a/input") == (
            b"a\nm\nz\n" if overwrite else b"z\na\n"
        )
        assert await ws.cache.get("/b/input") == b"m\n"
        left.load_state({"files": {"/input": b"changed\n"}})
        again = await ws.shell("cat /a/input" if overwrite else command)
        assert await again.materialize_stdout() == b"a\nm\nz\n"
    finally:
        await ws.close()


class _Uncapped(RAMVFS):
    max_du_entries = None


class _Capped(RAMVFS):
    max_du_entries = 2


@command("du", vfs="ram", spec=SPECS["du"])
async def _unmeasured_du(accessor, paths, texts, opts):
    return b"0\t" + paths[0].raw_path.encode() + b"\n", IOResult()


@pytest.mark.asyncio
async def test_du_walk_charges_each_mount_its_own_cap():
    # A du that reports no measurement leaves the line to this walk.
    outer, inner = _Uncapped(), _Capped()
    outer.load_state({"files": {f"/f{i}": b"x" for i in range(4)}})
    inner.load_state({"files": {f"/g{i}": b"y" for i in range(3)}})
    ws = Workspace({"/a": outer, "/a/b": inner}, mode=MountMode.WRITE)
    install(ws.mount("/a/b"), [_unmeasured_du])
    try:
        result = await ws.shell("du -a /a")
        rows = (await result.materialize_stdout()).decode().splitlines()
        assert [r for r in rows if "/a/f" in r] == [
            f"1\t/a/f{i}" for i in range(4)
        ]
        assert len([r for r in rows if "/a/b/g" in r]) == 2
        assert result.stderr == TRUNCATED_NOTE.encode() + b"\n"
        assert result.exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_du_x_never_lists_a_mount_below_the_operand():
    @replaces("readdir")
    async def refusing(accessor, path, **kwargs):
        raise eacces(path)

    ws = Workspace(
        {"/a": RAMVFS(), "/a/b": RAMVFS(), "/c": RAMVFS()},
        mode=MountMode.WRITE,
    )
    try:
        await ws.shell("echo aa > /a/f; echo ccc > /a/b/g; echo d > /c/h")
        install(ws.mount("/a/b"), [refusing])
        result = await ws.shell("du -x /a /c")
        assert await result.materialize_stdout() == b"3\t/a\n2\t/c\n"
        assert not result.stderr
        assert result.exit_code == 0
    finally:
        await ws.close()
