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
from mirage.commands.builtin.generic_bind.adapter import Builder
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.io import IOResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


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
            Builder("grep", fn), [], [], {}, dispatch, "/"
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
        assert result.reads["/b/input"] == b"m\n"
        left.load_state({"files": {"/input": b"changed\n"}})
        again = await ws.shell("cat /a/input" if overwrite else command)
        assert await again.materialize_stdout() == b"a\nm\nz\n"
    finally:
        await ws.close()
