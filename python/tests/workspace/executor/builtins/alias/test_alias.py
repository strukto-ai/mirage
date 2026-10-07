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
"""alias / unalias: definition and expansion, pinned against bash 5.2.37.

Expansion needs ``shopt -s expand_aliases`` (non-interactive default
off), takes effect from the next line read (a use on the defining line
does not expand), rewrites the head word into a fresh line so a value
holding a pipe is a pipe, and reports through ``type``/``command -v``.
"""

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.snapshot.state import apply_state_dict, to_state_dict


def _ws() -> Workspace:
    return Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[str, int]:
    io = await ws.shell(cmd)
    return (await io.stdout_str()), io.exit_code


@pytest.mark.asyncio
async def test_a_function_keeps_the_aliases_its_definition_saw():
    ws = _ws()
    await _run(ws, "shopt -s expand_aliases; alias a='echo 1'")
    await _run(ws, 'f() { a; }; g() { x=$(a); echo "[$x]"; }')
    await _run(ws, "alias a='echo 2'")
    assert await _run(ws, "f; g") == ("1\n[2]\n", 0)
    assert await _run(ws, "unalias a; f") == ("1\n", 0)
    await ws.close()


@pytest.mark.asyncio
async def test_no_expansion_without_shopt():
    ws = _ws()
    out, code = await _run(ws, "alias x='echo hi'\nx")
    assert code == 127
    await ws.close()


@pytest.mark.asyncio
async def test_expansion_from_next_line():
    ws = _ws()
    # Same line: the definition does not apply to the use.
    out, code = await _run(ws, "shopt -s expand_aliases\nalias x='echo hi'; x")
    assert code == 127
    # Next line: it does.
    out, _ = await _run(ws, "shopt -s expand_aliases\nalias y='echo hi'\ny")
    assert out == "hi\n"
    await ws.close()


@pytest.mark.asyncio
async def test_value_is_reparsed_as_a_line():
    ws = _ws()
    await _run(ws, "touch /data/foo /data/bar")
    out, _ = await _run(
        ws, "shopt -s expand_aliases\nalias lg='ls /data | grep'\nlg foo"
    )
    assert out == "foo\n"
    await ws.close()


@pytest.mark.asyncio
async def test_trailing_space_checks_next_word():
    ws = _ws()
    out, _ = await _run(
        ws,
        "shopt -s expand_aliases\nalias run='do '\n"
        "alias do='echo DID'\nrun echo hi",
    )
    assert out == "DID echo hi\n"
    await ws.close()


@pytest.mark.asyncio
async def test_list_and_query():
    ws = _ws()
    out, _ = await _run(ws, "alias x='echo hi'\nalias")
    assert out == "alias x='echo hi'\n"
    out, _ = await _run(ws, "alias x='echo hi'\ntype -t x; command -v x")
    assert out == "alias\nalias x='echo hi'\n"
    await ws.close()


@pytest.mark.asyncio
async def test_unalias():
    ws = _ws()
    out, code = await _run(ws, "alias x=1\nunalias x; alias x")
    assert code == 1
    _, code = await _run(ws, "unalias nope")
    assert code == 1
    _, code = await _run(ws, "unalias")
    assert code == 2
    await ws.close()


@pytest.mark.asyncio
async def test_bad_names():
    ws = _ws()
    _, code = await _run(ws, "alias 'a b'=x")
    assert code == 1
    _, code = await _run(ws, "alias 'a/b'=x")
    assert code == 1
    await ws.close()


@pytest.mark.asyncio
async def test_a_value_holding_a_quote_prints_re_readably():
    ws = _ws()
    out, _ = await _run(ws, 'alias x="it\'s a test"; alias x')
    assert out == "alias x='it'\\''s a test'\n"
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "aliases, line, result",
    [
        ("fi='echo F'", "fi", ("F\n", 0)),
        ("fi='echo F; fi'", "fi", ("", 2)),
        ("fi='echo ☕; fi'", "fi", ("", 2)),
        ("c='echo C; fi ' fi='echo F'", "c fi", ("C\nF echo F\n", 0)),
        ("c='echo C; ' fi='echo F; fi'", "c fi", ("", 2)),
        ("c='echo A; \\\n ' fi='fi; echo F'", "c fi", ("", 2)),
        (
            "fi='echo SAFE; : <<EOF; fi ' x=$':\\nbody\\nEOF\\n'",
            "fi x",
            ("", 2),
        ),
    ],
)
async def test_an_alias_spelled_as_a_reserved_word_runs(aliases, line, result):
    # Pinned against bash 5.2.37: an alias is tried before a reserved word
    # where a command starts, but inside its own text, which it never
    # expands again, its name is the reserved word.
    ws = _ws()
    await _run(ws, f"shopt -s expand_aliases; alias {aliases}")
    assert await _run(ws, line) == result
    await ws.close()


@pytest.mark.asyncio
async def test_an_alias_after_a_non_ascii_assignment_keeps_its_arguments():
    ws = _ws()
    await _run(ws, "shopt -s expand_aliases; alias e='echo E'")
    assert await _run(ws, "X=☕ e arg") == ("E arg\n", 0)
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "lines, out, code",
    [
        (["alias a='echo works'\nf() { a; }\nf"], "works\n", 0),
        (["alias a='echo x'; f() { a; }; f"], "", 127),
        (["alias a='echo x'; f() { a; }", "f"], "", 127),
        (["alias a='echo nested'\ng() { a; }\nf() { g; }\nf"], "nested\n", 0),
    ],
)
async def test_a_function_reads_aliases_where_it_was_defined(lines, out, code):
    # Pinned against bash 5.2.37: the body is read when the function is
    # defined, so an alias from the same row stays a plain word.
    ws = _ws()
    await ws.shell("shopt -s expand_aliases")
    for line in lines:
        result = await _run(ws, line)
    assert result == (out, code)
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "lines, out, code",
    [
        (["alias a='echo works'", "f() { a; }"], "works\n", 0),
        (["alias a='echo x'; f() { a; }"], "", 127),
    ],
)
async def test_a_call_with_its_own_env_or_cwd_reads_the_same_aliases(
    lines, out, code
):
    # A call with overrides runs on a fork, which carries the parse
    # count, the alias marks and where each function was defined, so it
    # reads the aliases a plain call reads.
    ws = _ws()
    await ws.shell("shopt -s expand_aliases")
    for line in lines:
        await ws.shell(line)
    for kwargs in ({}, {"env": {}}, {"cwd": "/data"}):
        io = await ws.shell("f", **kwargs)
        assert ((await io.stdout_str()), io.exit_code) == (out, code)
    await ws.close()


@pytest.mark.asyncio
async def test_a_checked_out_function_does_not_read_the_replaced_site():
    # Checkout restores the table but not where the live definitions
    # were made; a site recorded for another source is not the
    # function's, so the restored body runs as a parse of its own.
    ws = _ws()
    for line in (
        "shopt -s expand_aliases",
        "alias a='echo works'",
        "f() { a; }",
    ):
        await ws.shell(line)
    state = await to_state_dict(ws)
    await ws.shell("alias a='echo works'; f() { :; }")
    await apply_state_dict(ws, state)
    assert await _run(ws, "f") == ("works\n", 0)
    await ws.close()
