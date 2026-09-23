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
"""declare -n name references and declare -g global scope.

A reference resolves through ``deref`` on every read and write, so
``$r``, ``${r[@]}``, ``r=``, ``unset r``, ``[[ -v r ]]`` and ``$((r))``
all reach the target; ``${!r}`` is the target's name; ``-g`` writes the
global record even from inside a shadowing function. Pinned against
bash 5.2.37.
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
async def test_read_write_and_indirection():
    ws = _ws()
    out, _ = await _run(
        ws, "v=real; declare -n r=v; echo $r; r=2; echo $v; "
        "echo ${!r}")
    assert out == "real\n2\nv\n"
    await ws.close()


@pytest.mark.asyncio
async def test_arrays_and_assoc():
    ws = _ws()
    out, _ = await _run(
        ws, "arr=(1 2); declare -n r=arr; echo ${r[1]} "
        "${#r[@]}; r[2]=3; declare -p arr")
    assert out == '2 2\ndeclare -a arr=([0]="1" [1]="2" [2]="3")\n'
    out, _ = await _run(
        ws, "declare -A m=([k]=v); declare -n r=m; r[j]=w; "
        "declare -p m")
    assert out == 'declare -A m=([j]="w" [k]="v" )\n'
    await ws.close()


@pytest.mark.asyncio
async def test_tests_and_arithmetic():
    ws = _ws()
    out, _ = await _run(
        ws, "v=1; declare -n r=v; [[ -v r ]] && echo yes; "
        "echo $((r+1))")
    assert out == "yes\n2\n"
    await ws.close()


@pytest.mark.asyncio
async def test_unset_target_vs_reference():
    ws = _ws()
    out, code = await _run(ws, "v=1; declare -n r=v; unset r; declare -p v")
    assert code == 1
    out, code = await _run(ws, "v=1; declare -n r=v; unset -n r; echo $v")
    assert out == "1\n"
    await ws.close()


@pytest.mark.asyncio
async def test_bad_targets_and_self_reference():
    ws = _ws()
    _, code = await _run(ws, "declare -n r='a b'")
    assert code == 1
    _, code = await _run(ws, "declare -n s=s")
    assert code == 1
    _, code = await _run(ws, "a=(x y); declare -n r='a[1]'")
    assert code != 0
    await ws.close()


@pytest.mark.asyncio
async def test_local_nameref_and_read_printf():
    ws = _ws()
    out, _ = await _run(
        ws, "f(){ local -n ref=$1; ref=val; ref+=x; }; f target; echo $target")
    assert out == "valx\n"
    out, _ = await _run(
        ws, "declare -n r=v; read r <<< hi; echo $v; "
        "printf -v r '%s' pf; echo $v")
    assert out == "hi\npf\n"
    await ws.close()


@pytest.mark.asyncio
async def test_declare_g_reaches_global():
    ws = _ws()
    out, _ = await _run(ws, "f(){ declare -g G=1; }; f; echo $G")
    assert out == "1\n"
    out, _ = await _run(
        ws, "G=0; f(){ local G=5; declare -g G=1; echo $G; }; "
        "f; echo $G")
    assert out == "5\n1\n"
    out, _ = await _run(
        ws, "g(){ declare -g X=inner; }; f(){ local X=local; g; echo $X; }; "
        "f; echo $X")
    assert out == "local\ninner\n"
    await ws.close()


@pytest.mark.asyncio
async def test_declare_g_arrays():
    ws = _ws()
    out, _ = await _run(
        ws,
        "f(){ declare -ga A=(1 2); declare -gi I=3+4; }; f; declare -p A I")
    assert out == 'declare -a A=([0]="1" [1]="2")\ndeclare -i I="7"\n'
    await ws.close()
