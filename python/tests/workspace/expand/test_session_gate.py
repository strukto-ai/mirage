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
def guarded():
    """A workspace whose profile protects ``AWS_*`` and seeds one."""
    profile = {"vars": {"protect": ["AWS_*"]}, "env": {"AWS_REGION": "eu"}}
    with Workspace({"/ram/": RAMVFS()}, profiles={"default": profile}) as ws:
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
    "line,name",
    [
        ("export AWS_PROFILE=x", "AWS_PROFILE"),
        ("AWS_PROFILE=x", "AWS_PROFILE"),
        # Every expansion-time writer below lands in the store, which
        # refuses a protected name whichever door the write came in by.
        ('echo "${AWS_PROFILE:=x}"', "AWS_PROFILE"),
        ("echo $((AWS_LIMIT=5))", "AWS_LIMIT"),
        ('v=abcdef; echo "${v:$((AWS_LIMIT=1)):2}"', "AWS_LIMIT"),
        ('a=(one two); echo "${a[@]:${AWS_LIMIT:=1}}"', "AWS_LIMIT"),
        ("((AWS_LIMIT=5))", "AWS_LIMIT"),
        ("printf -v AWS_KEY %s x", "AWS_KEY"),
        ("for ((AWS_I=0; AWS_I<1; AWS_I++)); do :; done", "AWS_I"),
        # The write re-aims an unset reference, so the mark lands on a
        # name the assignment itself never named.
        ("declare -n ref; export ref=AWS_KEY", "AWS_KEY"),
        ("declare -n ref; readonly ref=AWS_KEY", "AWS_KEY"),
        ("AWS_KEY=x printenv AWS_KEY", "AWS_KEY"),
        ("read AWS_KEY <<< x", "AWS_KEY"),
        ("AWS_KEY+=(x)", "AWS_KEY"),
    ],
)
async def test_every_session_writer_refuses_a_protected_name(
    guarded, line: str, name: str
):
    result = await guarded.shell(line)
    assert result.exit_code == 1, f"{line!r} was not refused"
    assert f"{name}: permission denied".encode() in (result.stderr or b"")
    assert await value_of(guarded, name) == b"[]", f"{line!r} wrote anyway"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "AWS_REGION=us",
        "unset AWS_REGION",
        "unset 'AWS_REGION[0]'",
        "export -n AWS_REGION",
        "readonly AWS_REGION",
    ],
)
async def test_a_protected_name_reads_and_keeps_what_the_operator_set(
    guarded, line: str
):
    result = await guarded.shell(line)
    assert result.exit_code == 1, f"{line!r} was not refused"
    assert b"AWS_REGION: permission denied" in (result.stderr or b"")
    assert await value_of(guarded, "AWS_REGION") == b"[eu]"
    shown = await guarded.shell("declare -p AWS_REGION")
    assert shown.stdout == b'declare -x AWS_REGION="eu"\n'


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
async def test_a_name_no_rule_covers_still_writes(
    guarded, line: str, name: str, expected: bytes
):
    await guarded.shell(line)
    assert await value_of(guarded, name) == expected


@pytest.mark.asyncio
async def test_a_subscripted_printf_target_refuses_a_protected_name(guarded):
    # `printf -v name[i]` writes the session's array table, so it is a
    # session write like any other.
    result = await guarded.shell("printf -v 'AWS_KEY[0]' %s x")
    assert result.exit_code == 1
    assert b"AWS_KEY: permission denied" in (result.stderr or b"")
    read = await guarded.shell('echo "[${AWS_KEY[0]}]"')
    assert (read.stdout or b"").strip() == b"[]"


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
    guarded, line: str, expected: bytes
):
    result = await guarded.shell(line)
    assert (result.stdout or b"").strip() == expected


@pytest.mark.asyncio
async def test_refused_offset_does_not_expand_length(guarded):
    result = await guarded.shell(
        'v=abcdef; echo "${v:(AWS_LIMIT=1):${OTHER:=2}}"'
    )
    assert result.exit_code == 1
    assert b"AWS_LIMIT: permission denied" in (result.stderr or b"")
    assert await value_of(guarded, "AWS_LIMIT") == b"[]"
    assert await value_of(guarded, "OTHER") == b"[]"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,name,expected",
    [
        ("readonly SAFE=(one) AWS_BLOCKED=(two)", "SAFE", "-ar"),
        ("export SAFE=(one) AWS_BLOCKED=(two)", "SAFE", "-ax"),
        ("declare -rx SAFE=(one) AWS_BLOCKED=(two)", "SAFE", "-arx"),
    ],
)
async def test_a_refused_literal_leaves_the_stored_ones_marked(
    guarded, line: str, name: str, expected: str
):
    # The literals store first and take their marks once they all have;
    # a protected later one must not leave an earlier one stored but
    # unfrozen.
    result = await guarded.shell(line)
    assert b"AWS_BLOCKED: permission denied" in (result.stderr or b"")
    shown = await guarded.shell(f"declare -p {name}")
    assert shown.stdout == f'declare {expected} {name}=([0]="one")\n'.encode()


@pytest.mark.asyncio
async def test_a_literal_mark_stays_on_the_target_its_write_cleared(guarded):
    # The literal writes through `ref` to `T`; the plain operand then
    # re-aims `ref` at `AWS_KEY`, and the literal's `-x` must not follow
    # it to the protected name. Under `-n` it marks the reference itself.
    result = await guarded.shell(
        "T=old; declare -n ref=T; declare -nx ref=AWS_KEY ref=(one)"
    )
    assert result.exit_code == 0
    shown = await guarded.shell("declare -p ref AWS_KEY")
    assert shown.stdout == b'declare -nx ref="AWS_KEY"\n'
    assert b"AWS_KEY: not found" in (shown.stderr or b"")
