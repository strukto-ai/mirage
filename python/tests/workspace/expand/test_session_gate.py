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

from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest.fixture
def ws():
    """A workspace with one RAM mount."""
    with Workspace({"/ram/": RAMVFS()}) as ws:
        yield ws


async def value_of(ws, name: str) -> bytes:
    """What the shell reads back for one variable.

    Args:
        ws (Workspace): the workspace under test.
        name (str): variable name.
    """
    result = await ws.shell(f"echo [${name}]")
    return (result.stdout or b"").strip()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,name,expected",
    [
        ('echo "${OTHER:=x}"', "OTHER", b"[x]"),
        ("echo $((COUNT=5))", "COUNT", b"[5]"),
        ("((COUNT=5))", "COUNT", b"[5]"),
        ("printf -v KEY %s x", "KEY", b"[x]"),
        ("for ((I=0; I<1; I++)); do :; done", "I", b"[1]"),
    ],
)
async def test_an_expansion_write_lands(
    ws, line: str, name: str, expected: bytes
):
    await ws.shell(line)
    assert await value_of(ws, name) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        # bash 5.2: an arithmetic assignment to an array name writes
        # element 0 and leaves the rest of the array alone, and so does
        # a `${name:=}` default. Writing the whole variable as a scalar
        # instead discards every other element.
        ('A=(1 2 3); echo $((A=5)) >/dev/null; echo "${A[@]}"', b"5 2 3"),
        ('C=("" 9); echo "${C:=x}" >/dev/null; echo "${C[@]}"', b"x 9"),
        ('B=(1 2 3); printf -v B %s X; echo "${B[@]}"', b"X 2 3"),
        ("D=(1 2 3); printf -v 'D[1]' %s Y; echo \"${D[@]}\"", b"1 Y 3"),
    ],
)
async def test_an_expansion_write_keeps_the_other_elements(
    ws, line: str, expected: bytes
):
    result = await ws.shell(line)
    assert (result.stdout or b"").strip() == expected


@pytest.mark.asyncio
async def test_a_literal_mark_stays_on_the_target_its_write_cleared(ws):
    # The literal writes through `ref` to `T`; the plain operand then
    # re-aims `ref` at `AWS_KEY`, and the literal's `-x` must not follow
    # it there. Under `-n` it marks the reference itself.
    result = await ws.shell(
        "T=old; declare -n ref=T; declare -nx ref=AWS_KEY ref=(one)"
    )
    assert result.exit_code == 0
    shown = await ws.shell("declare -p ref AWS_KEY")
    assert shown.stdout == b'declare -nx ref="AWS_KEY"\n'
    assert b"AWS_KEY: not found" in (shown.stderr or b"")
