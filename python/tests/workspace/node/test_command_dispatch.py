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

from mirage.io.types import materialize
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import RunResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws() -> Workspace:
    return Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )


@pytest.mark.asyncio
async def test_rm_f_of_the_empty_name_removes_nothing():
    # rm -f silences the empty name's ENOENT, and the bookkeeping after a
    # clean rm used to purge the node table under its `virtual`, the
    # working directory, taking every link there with it.
    ws = _ws()
    await ws.shell("mkdir -p /data/d; echo x > /data/d/f; ln -s f /data/d/l")
    r = await ws.shell("cd /data/d && rm -rf ''")
    assert r.exit_code == 0
    assert ws.namespace.is_link("/data/d/l")
    assert (await ws.shell("cat /data/d/f")).stdout == b"x\n"


@pytest.mark.asyncio
async def test_a_loop_fails_its_operand_not_the_line():
    ws = _ws()
    await ws.shell(
        "echo a > /data/a.txt; echo b > /data/b.txt; "
        "ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2"
    )
    r = await ws.shell("cat /data/a.txt /data/l1 /data/b.txt")
    assert r.exit_code == 1
    assert r.stdout == b"a\nb\n"
    assert r.stderr == (b"cat: /data/l1: Too many levels of symbolic links\n")


class ShellsOut(LanguageRuntime):
    name = "shellsout"
    language = "python"

    def __init__(self) -> None:
        super().__init__(captures=["python3"])

    async def interpret(
        self, engine, program, ctx, output=None, errors=None
    ) -> RunResult:
        nested = await ctx.shell("printenv TOKEN")
        return RunResult(
            stdout=await materialize(nested.stdout), stderr=None, exit_code=0
        )


# A run starts as its output is read, after dispatch returned, and the
# lines it shells out still run under its prefix assignment.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["TOKEN=one python3 -c x", "TOKEN=one python3 -c x | cat"]
)
async def test_a_lazy_run_shells_out_under_its_prefix(line):
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[ShellsOut()]
    )
    try:
        assert (await ws.shell(line)).stdout == b"one\n"
        after = await ws.shell('echo "[$TOKEN]"')
        assert after.stdout == b"[]\n"
    finally:
        await ws.close()
