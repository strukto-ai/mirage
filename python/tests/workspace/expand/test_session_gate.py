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

from mirage.policy import Action, Deny, Policy
from mirage.policy.types import SessionContext
from mirage.resource.ram import RAMResource
from mirage.workspace import Workspace


class DenyAws(Policy):
    """Refuses any session write naming an AWS variable."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.key.startswith("AWS_"):
            return Deny("not yours to set\n")
        return None


@pytest.fixture
def guarded():
    """A workspace whose policy refuses writes to ``AWS_*``."""
    with Workspace({"/ram/": RAMResource()}, policies=[DenyAws()]) as ws:
        yield ws


async def value_of(ws, name: str) -> bytes:
    """What the shell reads back for one variable.

    Args:
        ws (Workspace): the workspace under test.
        name (str): variable name.
    """
    result = await ws.execute(f"echo [${name}]")
    return (result.stdout or b"").strip()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,name",
    [
        ("export AWS_PROFILE=x", "AWS_PROFILE"),
        ("AWS_PROFILE=x", "AWS_PROFILE"),
        # Every expansion-time writer below reached the session env
        # directly, so a pre_session rule was one `${X:=}` away from
        # being irrelevant.
        ('echo "${AWS_PROFILE:=x}"', "AWS_PROFILE"),
        ("echo $((AWS_LIMIT=5))", "AWS_LIMIT"),
        ("((AWS_LIMIT=5))", "AWS_LIMIT"),
        ("printf -v AWS_KEY %s x", "AWS_KEY"),
        ("for ((AWS_I=0; AWS_I<1; AWS_I++)); do :; done", "AWS_I"),
    ],
)
async def test_every_session_writer_clears_the_gate(guarded, line: str,
                                                    name: str):
    result = await guarded.execute(line)
    assert result.exit_code != 0, f"{line!r} was not refused"
    assert b"not yours to set" in (result.stderr or b""), line
    assert await value_of(guarded, name) == b"[]", f"{line!r} wrote anyway"


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
async def test_a_name_no_rule_covers_still_writes(guarded, line: str,
                                                  name: str, expected: bytes):
    await guarded.execute(line)
    assert await value_of(guarded, name) == expected


@pytest.mark.asyncio
async def test_a_subscripted_printf_target_clears_the_gate(guarded):
    # `printf -v name[i]` writes the session's array table, so it is a
    # session write like any other. Taking the direct path for it left
    # `printf -v 'AWS_KEY[0]'` as the one spelling a pre_session rule
    # could not refuse.
    result = await guarded.execute("printf -v 'AWS_KEY[0]' %s x")
    assert result.exit_code != 0
    assert b"not yours to set" in (result.stderr or b"")
    read = await guarded.execute('echo "[${AWS_KEY[0]}]"')
    assert (read.stdout or b"").strip() == b"[]"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        # bash 5.2: an arithmetic assignment to an array name writes
        # element 0 and leaves the rest of the array alone, and so does
        # a `${name:=}` default. Writing the whole variable as a scalar
        # instead discards every other element.
        ("A=(1 2 3); echo $((A=5)) >/dev/null; echo \"${A[@]}\"", b"5 2 3"),
        ('C=("" 9); echo "${C:=x}" >/dev/null; echo "${C[@]}"', b"x 9"),
        ("B=(1 2 3); printf -v B %s X; echo \"${B[@]}\"", b"X 2 3"),
        ("D=(1 2 3); printf -v 'D[1]' %s Y; echo \"${D[@]}\"", b"1 Y 3"),
    ],
)
async def test_an_expansion_write_keeps_the_other_elements(
        guarded, line: str, expected: bytes):
    result = await guarded.execute(line)
    assert (result.stdout or b"").strip() == expected
