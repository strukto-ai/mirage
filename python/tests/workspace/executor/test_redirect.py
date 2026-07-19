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


async def _workspace() -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /data")
    return ws


async def _out(ws: Workspace, cmd: str) -> str:
    io = await ws.execute(cmd)
    return (io.stdout or b"").decode()


@pytest.mark.asyncio
async def test_redirect_target_expands_after_cd_in_list():
    # tree-sitter hoists the trailing redirect over the && list; the
    # target must still expand with the cwd the last command sees.
    ws = await _workspace()
    await ws.execute("cd /data && echo hi > OUT")
    assert await _out(ws, "cat /data/OUT") == "hi\n"


@pytest.mark.asyncio
async def test_redirect_captures_only_last_command():
    ws = await _workspace()
    out = await _out(ws, "echo one && echo two > /data/f")
    assert out == "one\n"
    assert await _out(ws, "cat /data/f") == "two\n"


@pytest.mark.asyncio
async def test_redirect_short_circuit_and():
    ws = await _workspace()
    io = await ws.execute("false && echo never > /data/f3")
    assert io.exit_code == 1
    io = await ws.execute("test -f /data/f3")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_redirect_short_circuit_or():
    ws = await _workspace()
    await ws.execute("false || echo fallback > /data/f4")
    assert await _out(ws, "cat /data/f4") == "fallback\n"


@pytest.mark.asyncio
async def test_redirect_chain_compounds():
    # Each redirect re-associates independently, so a multi-redirect
    # chain executes left to right instead of hoisting.
    ws = await _workspace()
    out = await _out(
        ws, "echo a > /data/c && echo b >> /data/c && cat /data/c"
        " && wc -l < /data/c")
    assert out == "a\nb\n2\n"


@pytest.mark.asyncio
async def test_redirect_group_keeps_whole_body():
    # Compound bodies are real bash group redirects, not hoists.
    ws = await _workspace()
    await ws.execute("{ echo g1; echo g2; } > /data/grp")
    assert await _out(ws, "cat /data/grp") == "g1\ng2\n"


@pytest.mark.asyncio
async def test_redirect_subshell_keeps_whole_body():
    ws = await _workspace()
    await ws.execute("(echo s1; echo s2) > /data/subq")
    assert await _out(ws, "cat /data/subq") == "s1\ns2\n"


@pytest.mark.asyncio
async def test_redirect_pipeline_right_side():
    ws = await _workspace()
    out = await _out(
        ws, "echo x && echo y | tr a-z A-Z > /data/up && cat /data/up")
    assert out == "x\nY\n"


@pytest.mark.asyncio
async def test_stdin_redirect_binds_last_command():
    ws = await _workspace()
    await ws.execute("printf 'l1\\nl2\\n' | tee /data/seed > /dev/null")
    out = await _out(ws, "echo lead && wc -l < /data/seed")
    assert out == "lead\n2\n"


@pytest.mark.asyncio
async def test_fd_table_file_then_merge():
    # `> f 2>&1` — fd2 follows fd1 into the file (canonical idiom).
    ws = await _workspace()
    io = await ws.execute("{ echo out; ls /data/missing; } > /data/both 2>&1")
    assert (io.stdout or b"") == b""
    assert io.stderr is None
    both = await _out(ws, "cat /data/both")
    assert both.startswith("out\n")
    assert "missing" in both


@pytest.mark.asyncio
async def test_fd_table_merge_then_file():
    # `2>&1 > f` — fd2 keeps the ORIGINAL stdout; only stdout hits f.
    ws = await _workspace()
    io = await ws.execute("{ echo out; ls /data/missing; } 2>&1 > /data/only")
    assert b"missing" in (io.stdout or b"")
    assert await _out(ws, "cat /data/only") == "out\n"


@pytest.mark.asyncio
async def test_fd_table_stdout_dup_then_stderr_file():
    # `>&2 2>> f` — fd1 points at the ORIGINAL stderr before fd2 moves.
    ws = await _workspace()
    io = await ws.execute("echo a >&2 2>> /data/elog")
    assert (io.stdout or b"") == b""
    assert (io.stderr or b"") == b"a\n"
    assert await _out(ws, "cat /data/elog") == ""


@pytest.mark.asyncio
async def test_multiple_stdout_redirects_truncate_all_write_last():
    ws = await _workspace()
    await ws.execute("echo body > /data/m1 > /data/m2")
    assert await _out(ws, "cat /data/m1") == ""
    assert await _out(ws, "cat /data/m2") == "body\n"


@pytest.mark.asyncio
async def test_bare_redirect_creates_empty_file():
    ws = await _workspace()
    io = await ws.execute("> /data/bare")
    assert io.exit_code == 0
    io = await ws.execute("test -f /data/bare")
    assert io.exit_code == 0
    assert await _out(ws, "cat /data/bare") == ""


@pytest.mark.asyncio
async def test_stderr_redirect_creates_file_even_when_empty():
    ws = await _workspace()
    await ws.execute("echo fine 2> /data/errs")
    io = await ws.execute("test -f /data/errs")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_both_redirect_append():
    ws = await _workspace()
    await ws.execute("echo one &> /data/acc")
    await ws.execute("ls /data/nope &>> /data/acc")
    await ws.execute("echo three &>> /data/acc")
    acc = await _out(ws, "cat /data/acc")
    assert acc.startswith("one\n")
    assert acc.endswith("three\n")
    assert "nope" in acc


@pytest.mark.asyncio
async def test_heredoc_with_file_redirect():
    # `cat <<END > f` — the file redirect parses INSIDE the heredoc
    # node and must still be applied.
    ws = await _workspace()
    io = await ws.execute("cat <<END > /data/hd\nwritten\nEND")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b""
    assert await _out(ws, "cat /data/hd") == "written\n"


@pytest.mark.asyncio
async def test_stdin_from_process_substitution():
    ws = await _workspace()
    out = await _out(ws, "wc -l < <(printf 'x\\ny\\n')")
    assert out.strip() == "2"
