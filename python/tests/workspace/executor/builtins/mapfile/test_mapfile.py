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
"""mapfile / readarray: lines into an array, pinned against bash 5.2.37.

``-t`` strips the delimiter, ``-d`` changes it, ``-n``/``-s``/``-O``
bound and place the slice, ``-C``/``-c`` call back, and the target
defaults to ``MAPFILE``; a scalar becomes an array and an associative
one is refused.
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
async def test_strip_and_keep_delimiter():
    ws = _ws()
    out, _ = await _run(
        ws, "printf 'a\\nb\\nc\\n' | { mapfile -t A; "
        "declare -p A; }")
    assert out == 'declare -a A=([0]="a" [1]="b" [2]="c")\n'
    out, _ = await _run(ws, "printf 'a\\nb\\n' | { mapfile A; declare -p A; }")
    assert out == 'declare -a A=([0]=$\'a\\n\' [1]=$\'b\\n\')\n'
    await ws.close()


@pytest.mark.asyncio
async def test_delimiter_count_skip_origin():
    ws = _ws()
    out, _ = await _run(
        ws, "printf 'a:b:c' | { mapfile -d : -t D; "
        "declare -p D; }")
    assert out == 'declare -a D=([0]="a" [1]="b" [2]="c")\n'
    out, _ = await _run(
        ws, "printf '1\\n2\\n3\\n' | { mapfile -t -n 2 N; "
        "declare -p N; }")
    assert out == 'declare -a N=([0]="1" [1]="2")\n'
    out, _ = await _run(
        ws, "printf '1\\n2\\n3\\n' | { mapfile -t -s 1 S; "
        "declare -p S; }")
    assert out == 'declare -a S=([0]="2" [1]="3")\n'
    out, _ = await _run(
        ws, "printf 'x\\ny\\n' | { O=(a b c d); "
        "mapfile -t -O 1 O; declare -p O; }")
    assert out == 'declare -a O=([0]="a" [1]="x" [2]="y" [3]="d")\n'
    await ws.close()


@pytest.mark.asyncio
async def test_default_name_and_callback():
    ws = _ws()
    out, _ = await _run(ws, "mapfile <<< 'z'; declare -p MAPFILE")
    assert out == 'declare -a MAPFILE=([0]=$\'z\\n\')\n'
    out, _ = await _run(
        ws, "printf '1\\n2\\n3\\n4\\n' | { cb(){ echo \"cb $1 $2\"; }; "
        "mapfile -t -C cb -c 2 M; }")
    assert out == "cb 1 2\ncb 3 4\n"
    await ws.close()


@pytest.mark.asyncio
async def test_readarray_alias_and_kind_refusal():
    ws = _ws()
    out, _ = await _run(ws, "readarray -t R <<< $'x\\ny'; declare -p R")
    assert out == 'declare -a R=([0]="x" [1]="y")\n'
    out, _ = await _run(
        ws, "S=hello; printf 'x\\n' | { mapfile -t S; "
        "declare -p S; }")
    assert out == 'declare -a S=([0]="x")\n'
    _, code = await _run(ws, "declare -A M; printf 'x\\n' | { mapfile -t M; }")
    assert code == 1
    await ws.close()


@pytest.mark.asyncio
async def test_bad_options():
    ws = _ws()
    _, code = await _run(ws, "mapfile -z X")
    assert code == 2
    _, code = await _run(ws, "mapfile -n x X")
    assert code == 1
    _, code = await _run(ws, "mapfile 1bad")
    assert code == 1
    await ws.close()


@pytest.mark.asyncio
async def test_callback_gets_the_record_as_one_argument():
    """A record is data, not source: bash single-quotes it into the
    callback line, so shell syntax inside one neither runs nor splits."""
    ws = _ws()
    out, _ = await _run(
        ws, "cb(){ echo \"argc=$# [$2]\"; }; "
        "printf 'x; touch /data/ran\\nb c\\n' | { mapfile -c 1 -C cb -t A; }; "
        "test -e /data/ran && echo RAN || echo clean")
    assert out == ("argc=2 [x; touch /data/ran]\n"
                   "argc=2 [b c]\n"
                   "clean\n")
    await ws.close()


@pytest.mark.asyncio
async def test_callback_survives_a_quote_in_the_record():
    ws = _ws()
    out, _ = await _run(
        ws, "cb(){ echo \"[$2]\"; }; "
        "printf \"it's here\\n\" | { mapfile -c 1 -C cb -t B; }")
    assert out == "[it's here]\n"
    await ws.close()
