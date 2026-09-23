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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws() -> Workspace:
    return Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[str, str, int]:
    io = await ws.shell(cmd)
    return (await io.stdout_str()), (await io.stderr_str()), io.exit_code


@pytest.mark.asyncio
async def test_array_literal_then_append_continues_at_the_extent():
    ws = _ws()
    out, _, _ = await _run(ws, "a=(x y); a+=(z); declare -p a")
    assert out == 'declare -a a=([0]="x" [1]="y" [2]="z")\n'


@pytest.mark.asyncio
async def test_scalar_on_an_indexed_array_writes_element_zero():
    ws = _ws()
    out, _, _ = await _run(ws, "a=(x y); a=q; declare -p a")
    assert out == 'declare -a a=([0]="q" [1]="y")\n'


@pytest.mark.asyncio
async def test_subscript_is_arithmetic_when_indexed():
    ws = _ws()
    out, _, _ = await _run(ws, "a=(x y z); a[1+1]=Q; declare -p a")
    assert out == 'declare -a a=([0]="x" [1]="y" [2]="Q")\n'


@pytest.mark.asyncio
async def test_subscript_is_a_literal_key_when_associative():
    ws = _ws()
    out, _, _ = await _run(ws, "declare -A m; m[1+1]=v; declare -p m")
    assert out == 'declare -A m=([1+1]="v" )\n'


@pytest.mark.asyncio
async def test_scalar_on_an_associative_array_writes_key_zero():
    ws = _ws()
    out, _, _ = await _run(ws, "declare -A m; m[k]=v; m=x; declare -p m")
    assert '[0]="x"' in out and '[k]="v"' in out


@pytest.mark.asyncio
async def test_append_on_an_integer_name_adds_rather_than_concatenates():
    ws = _ws()
    out, _, _ = await _run(ws, "declare -i n=5; n+=3; echo $n")
    assert out == "8\n"


@pytest.mark.asyncio
async def test_an_associative_subscript_that_expands_empty_aborts_the_line():
    # GNU 5.2.37 names the raw spelling, not the expanded key, and the
    # rest of the line is abandoned.
    ws = _ws()
    out, err, code = await _run(ws, "declare -A m; e=; m[$e]=v; echo REACHED")
    assert out == ""
    assert err == "bash: m[$e]: bad array subscript\n"
    assert code == 1


@pytest.mark.asyncio
async def test_an_indexed_subscript_that_expands_empty_stays_legal():
    # The asymmetry above: arithmetic on nothing is 0, so only the
    # associative kind checks the expanded text.
    ws = _ws()
    out, _, code = await _run(ws, "a=(x y); e=; a[$e]=Q; declare -p a")
    assert out == 'declare -a a=([0]="Q" [1]="y")\n'
    assert code == 0


@pytest.mark.asyncio
async def test_assigning_a_readonly_name_aborts_the_line():
    ws = _ws()
    out, err, code = await _run(ws, "readonly r=1; r=2; echo REACHED")
    assert out == ""
    assert err == "bash: r: readonly variable\n"
    assert code == 1


@pytest.mark.asyncio
async def test_an_assignment_only_statement_takes_the_last_substitution():
    # The statement's status follows the last command substitution across
    # ALL its assignments, not the last child's.
    ws = _ws()
    _, _, code = await _run(ws, "a=$(true) b=$(false)")
    assert code == 1
