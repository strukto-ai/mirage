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


def _ws() -> Workspace:
    return Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[str, int]:
    io = await ws.shell(cmd)
    return (await io.stdout_str()), io.exit_code


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
        ws, "shopt -s expand_aliases\nalias lg='ls /data | grep'\nlg foo")
    assert out == "foo\n"
    await ws.close()


@pytest.mark.asyncio
async def test_trailing_space_checks_next_word():
    ws = _ws()
    out, _ = await _run(
        ws, "shopt -s expand_aliases\nalias run='do '\n"
        "alias do='echo DID'\nrun echo hi")
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
    out, _ = await _run(ws, "alias x=\"it's a test\"; alias x")
    assert out == "alias x='it'\\''s a test'\n"
    await ws.close()
