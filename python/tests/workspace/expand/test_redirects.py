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

from mirage import MountMode, RAMResource, Workspace


async def _workspace_at(cwd: str) -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute(f"mkdir -p {cwd}")
    await ws.execute(f"cd {cwd}")
    return ws


@pytest.mark.asyncio
async def test_redirect_bare_target_resolves_against_cwd():
    # A redirect target is a path by definition: `> BARE` must write
    # cwd/BARE even though the bare word would classify as text.
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > BARE")
    io = await ws.execute("cat /data/BARE")
    assert (io.stdout or b"") == b"hi\n"


@pytest.mark.asyncio
async def test_redirect_extensionless_relative_target():
    ws = await _workspace_at("/data")
    await ws.execute("mkdir -p /data/sub")
    await ws.execute("echo hi > sub/OUT")
    io = await ws.execute("cat /data/sub/OUT")
    assert (io.stdout or b"") == b"hi\n"


@pytest.mark.asyncio
async def test_redirect_append_relative_target():
    ws = await _workspace_at("/data")
    await ws.execute("echo one > LOG")
    await ws.execute("echo two >> LOG")
    io = await ws.execute("cat /data/LOG")
    assert (io.stdout or b"") == b"one\ntwo\n"


@pytest.mark.asyncio
async def test_redirect_stdin_relative_source():
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > IN")
    io = await ws.execute("wc -l < IN")
    assert (io.stdout or b"").strip() == b"1"


@pytest.mark.asyncio
async def test_redirect_absolute_target_unchanged():
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > /data/ABS")
    io = await ws.execute("cat /data/ABS")
    assert (io.stdout or b"") == b"hi\n"


async def _stdout(ws: Workspace, cmd: str) -> str:
    io = await ws.execute(cmd)
    return (io.stdout or b"").decode()


@pytest.mark.asyncio
async def test_heredoc_expands_braced_var_and_cmdsub():
    ws = await _workspace_at("/data")
    out = await _stdout(
        ws, 'v=mirage\ncat <<END\nval=$v\nbrace=${v}\nsub=$(echo inner)\nEND')
    assert out == "val=mirage\nbrace=mirage\nsub=inner\n"


@pytest.mark.asyncio
async def test_heredoc_expands_arithmetic():
    # In heredoc bodies tree-sitter parses $((...)) as a command
    # substitution wrapping a subshell; it must still evaluate as math.
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END\nmath=$((2 + 3))\nEND")
    assert out == "math=5\n"


@pytest.mark.asyncio
async def test_heredoc_undefined_var_expands_empty():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END\n[$__undefined_var__]\nEND")
    assert out == "[]\n"


@pytest.mark.asyncio
async def test_heredoc_escaped_dollar_stays_literal():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "v=real\ncat <<END\nesc=\\$v exp=$v\nEND")
    assert out == "esc=$v exp=real\n"


@pytest.mark.asyncio
async def test_heredoc_backslash_newline_joins_lines():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END\nline \\\njoined\nEND")
    assert out == "line joined\n"


@pytest.mark.asyncio
async def test_heredoc_quoted_delimiter_disables_expansion():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "v=zzz\ncat <<'END'\nraw=$v\nsub=$(echo x)\nEND")
    assert out == "raw=$v\nsub=$(echo x)\n"


@pytest.mark.asyncio
async def test_heredoc_partially_quoted_delimiter_disables_expansion():
    # Any quoting anywhere in the delimiter counts (bash semantics).
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<EN'D'\nmixed=$((1+1))\nEND\n")
    assert out == "mixed=$((1+1))\n"


@pytest.mark.asyncio
async def test_heredoc_dash_strips_tabs_not_spaces():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<-END\n\ttab-stripped\n   spaces-kept\nEND")
    assert out == "tab-stripped\n   spaces-kept\n"


@pytest.mark.asyncio
async def test_heredoc_dash_strips_tabs_before_expansion():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "v=deep\ncat <<-END\n\t$v\n\t\tEND")
    assert out == "deep\n"


@pytest.mark.asyncio
async def test_heredoc_into_pipeline():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "cat <<END | tr a-z A-Z\nshout this\nEND")
    assert out == "SHOUT THIS\n"


@pytest.mark.asyncio
async def test_procsub_stdin_redirect():
    ws = await _workspace_at("/data")
    out = await _stdout(ws, "sort < <(printf 'b\\na\\n')")
    assert out == "a\nb\n"


@pytest.mark.asyncio
async def test_procsub_output_redirect_errors_loudly():
    # `> >(cmd)` would classify the procsub text as a literal filename
    # and write silently wrong state; it must fail like argv-position
    # output procsub.
    ws = await _workspace_at("/data")
    io = await ws.execute("echo hi > >(cat)")
    assert io.exit_code == 2
    assert b"unsupported: process substitution" in (io.stderr or b"")
