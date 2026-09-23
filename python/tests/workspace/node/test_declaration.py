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
async def test_an_unknown_option_letter_refuses_before_any_operand():
    ws = _ws()
    out, err, code = await _run(ws, "declare -q NAME")
    assert out == ""
    assert err == ("bash: declare: -q: invalid option\n"
                   "declare: usage: declare [-aAfFgiIlnrtux] [name[=value] "
                   "...] or declare -p [-aAfFilnrtux] [name ...]\n")
    assert code == 2


@pytest.mark.asyncio
async def test_readonly_and_export_both_land_on_one_declaration():
    # Readonly answers first, so the export stamp has to land in the
    # readonly branch too or `-r` silently eats the `-x`.
    ws = _ws()
    out, _, _ = await _run(ws, "declare -rx X=1; declare -p X")
    assert out == 'declare -rx X="1"\n'


@pytest.mark.asyncio
async def test_lower_and_upper_in_one_cluster_set_neither():
    ws = _ws()
    out, _, _ = await _run(ws, "declare -lu s=aBc; declare -p s")
    assert out == 'declare -- s="aBc"\n'


@pytest.mark.asyncio
async def test_a_shaping_letter_applies_to_later_writes_not_the_held_value():
    ws = _ws()
    out, _, _ = await _run(
        ws, "v=MiXeD; declare -l v; declare -p v; v=ABC; declare -p v")
    assert out == 'declare -l v="MiXeD"\ndeclare -l v="abc"\n'


@pytest.mark.asyncio
async def test_the_two_array_kinds_refuse_to_convert():
    ws = _ws()
    _, err, code = await _run(ws, "declare -a a; declare -A a")
    assert err == ("bash: declare: a: cannot convert indexed to "
                   "associative array\n")
    assert code == 1


@pytest.mark.asyncio
async def test_plus_r_on_a_readonly_name_refuses_and_keeps_it_frozen():
    ws = _ws()
    _, err, code = await _run(ws, "readonly r=1; declare +r r")
    assert err == "bash: declare: r: readonly variable\n"
    assert code == 1


@pytest.mark.asyncio
async def test_plus_a_cannot_destroy_an_indexed_array():
    ws = _ws()
    _, err, code = await _run(ws, "a=(x); declare +a a")
    assert err == ("bash: declare: a: cannot destroy array variables "
                   "in this way\n")
    assert code == 1


@pytest.mark.asyncio
async def test_a_refused_operand_does_not_cost_its_siblings_their_marks():
    # `declare -x GOOD=1 1BAD=x` exits 1 and still exports GOOD: the
    # stamp reads the names the handler stored, not the exit code.
    ws = _ws()
    out, err, _ = await _run(ws, "declare -x GOOD=1 1BAD=x; declare -p GOOD")
    assert "not a valid identifier" in err
    assert out == 'declare -x GOOD="1"\n'


@pytest.mark.asyncio
async def test_an_unquoted_empty_expansion_is_removed_by_word_splitting():
    # `export $UNSET` is a bare `export` and prints the listing; the
    # quoted form is a real, empty operand and refuses.
    ws = _ws()
    _, _, bare = await _run(ws, "export $NOPE")
    assert bare == 0
    _, err, code = await _run(ws, 'export "$NOPE"')
    assert err == "bash: export: `': not a valid identifier\n"
    assert code == 1


@pytest.mark.asyncio
async def test_a_staged_array_literal_leaves_the_old_value_intact():
    # Array literals are staged, not stored, so `readonly -a a=(y)` on
    # an already-readonly name fails with the old value intact. GNU
    # treats it as a fatal variable-assignment error, so the rest of
    # that line never runs -- the value is read back on the next one.
    ws = _ws()
    _, err, code = await _run(
        ws, "readonly -a a=(x); readonly -a a=(y); "
        "echo REACHED")
    assert err == "bash: a: readonly variable\n"
    assert code == 1
    out, _, _ = await _run(ws, "declare -p a")
    assert out == 'declare -ar a=([0]="x")\n'
