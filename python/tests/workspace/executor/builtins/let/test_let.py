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
"""let: ``(( ))`` as a builtin, pinned against bash 5.2.37.

Each operand is one expression; the status is 1 when the last evaluated
to 0; the writes land in order; a malformed operand aborts the builtin.
"""
import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws() -> Workspace:
    return Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[str, int]:
    io = await ws.shell(cmd)
    return (await io.stdout_str()), io.exit_code


@pytest.mark.asyncio
async def test_assigns_and_reports_last_value_status():
    ws = _ws()
    assert await _run(ws, "let x=1+2; echo $x") == ("3\n", 0)
    _, code = await _run(ws, "let z=0")
    assert code == 1
    _, code = await _run(ws, "let a=1 b=0")
    assert code == 1
    _, code = await _run(ws, "let b=0 a=1")
    assert code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_no_operand_and_bad_expression():
    ws = _ws()
    _, code = await _run(ws, "let")
    assert code == 1
    _, code = await _run(ws, "let 'q=1+'")
    assert code == 1
    await ws.close()


@pytest.mark.asyncio
async def test_array_element_and_increment():
    ws = _ws()
    out, _ = await _run(ws, "a=(1 2); let 'a[1]+=5'; declare -p a")
    assert out == 'declare -a a=([0]="1" [1]="7")\n'
    out, _ = await _run(ws, "x=3; let x++; echo $x")
    assert out == "4\n"
    await ws.close()
