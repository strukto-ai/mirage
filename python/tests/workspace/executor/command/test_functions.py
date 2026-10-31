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

from mirage.shell.constants import NESTING_MAX
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


async def _run(line: str) -> tuple[str, str, int]:
    ws = Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await ws.shell(line)
        return await io.stdout_str(), await io.stderr_str(), io.exit_code
    finally:
        await ws.close()


def _refused(name: str, limit: int) -> str:
    return f"bash: {name}: maximum function nesting level exceeded ({limit})\n"


@pytest.mark.asyncio
async def test_a_call_past_the_limit_abandons_the_line():
    out, err, code = await _run(
        'f() { echo "d$1"; f $(($1+1)); }; f 1; echo same-line'
    )
    assert out.split() == [f"d{n}" for n in range(1, NESTING_MAX + 1)]
    assert err == _refused("f", NESTING_MAX)
    assert code == 1


@pytest.mark.asyncio
async def test_substitution_recursion_stops_at_the_limit():
    out, err, code = await _run('f() { echo $(f); }; f; echo "next $?"')
    assert (out, err, code) == ("\nnext 0\n", _refused("f", NESTING_MAX), 0)


@pytest.mark.asyncio
async def test_funcnest_lowers_the_limit():
    out, err, code = await _run(
        'FUNCNEST=" +2 "; f() { echo "d$1"; f $(($1+1)); }; f 1'
    )
    assert (out, err, code) == ("d1\nd2\n", _refused("f", 2), 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["100", "0", "-1", "3x", ""])
async def test_funcnest_never_raises_the_limit(value: str):
    _, err, code = await _run(f'FUNCNEST="{value}"; f() {{ f; }}; f')
    assert (err, code) == (_refused("f", NESTING_MAX), 1)


@pytest.mark.asyncio
async def test_a_sourced_file_is_not_a_function_level():
    out, err, code = await _run(
        "echo g > /r/s.sh; FUNCNEST=2; g() { echo g; }; f() { source /r/s.sh; }; f"
    )
    assert (out, err, code) == ("g\n", "", 0)
