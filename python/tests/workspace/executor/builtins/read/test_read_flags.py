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
"""read flags: -a -d -n -N -t plus the non-tty no-ops, vs bash 5.2.37."""
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
async def test_array():
    ws = _ws()
    out, _ = await _run(ws, "echo 'p q r' | { read -a W; declare -p W; }")
    assert out == 'declare -a W=([0]="p" [1]="q" [2]="r")\n'
    await ws.close()


@pytest.mark.asyncio
async def test_delimiter():
    ws = _ws()
    out, _ = await _run(ws, "printf 'ab:cd' | { read -d : X; echo \"[$X]\"; }")
    assert out == "[ab]\n"
    out, _ = await _run(ws,
                        "printf 'a\\0b' | { read -d '' X; echo \"[$X]\"; }")
    assert out == "[a]\n"
    await ws.close()


@pytest.mark.asyncio
async def test_char_count():
    ws = _ws()
    out, _ = await _run(ws, "printf 'wxyz' | { read -n 2 Y; echo \"[$Y]\"; }")
    assert out == "[wx]\n"
    out, _ = await _run(
        ws, "printf 'a b c' | { read -n 3 A B; echo "
        "\"[$A][$B]\"; }")
    assert out == "[a][b]\n"
    out, _ = await _run(
        ws, "printf 'a b\\ncd' | { read -N 4 A; echo "
        "\"[$A]\"; }")
    assert out == "[a b\n]\n"
    await ws.close()


@pytest.mark.asyncio
async def test_timeout_and_no_ops():
    ws = _ws()
    _, code = await _run(ws, "read -t 1 Z </dev/null")
    assert code == 1
    # `read -t 0` with a source present answers 0 (select reports EOF
    # readable), matching bash.
    _, code = await _run(ws, "read -t 0 W </dev/null")
    assert code == 0
    out, _ = await _run(ws, "echo v | { read -p 'P: ' -s V; echo \"[$V]\"; }")
    assert out == "[v]\n"
    _, code = await _run(ws, "read -t x V")
    assert code == 1
    _, code = await _run(ws, "read -u 3 V")
    assert code == 1
    await ws.close()


@pytest.mark.asyncio
async def test_status_is_one_at_eof_without_delimiter():
    ws = _ws()
    out, code = await _run(
        ws, "printf 'ab' | { read -n 5 A; echo "
        "\"[$A]$?\"; }")
    assert out == "[ab]1\n"
    await ws.close()
