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

import asyncio

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


@pytest.fixture
def ws():
    mem = RAMResource()
    asyncio.run(mem.write("/hello.txt", data=b"hello world\n"))
    asyncio.run(mem.write("/numbers.txt", data=b"3\n1\n2\n1\n3\n"))
    asyncio.run(
        mem.write(
            "/log.txt",
            data=b"INFO start\nERROR fail\nINFO ok\nERROR bad\nINFO done\n"))
    asyncio.run(mem.mkdir("/subdir"))
    asyncio.run(mem.write("/subdir/a.txt", data=b"aaa\n"))
    asyncio.run(mem.write("/subdir/b.txt", data=b"bbb\n"))
    asyncio.run(mem.write("/config.json", data=b'{"key": "value"}\n'))
    lines = "\n".join(f"row {i}" for i in range(5000)) + "\n"
    asyncio.run(mem.write("/big.txt", data=lines.encode()))
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    ws.get_session(ws.default_session_id).cwd = "/"
    return ws


# --- Pipes ---


@pytest.mark.asyncio
async def test_pipe_grep_sort_uniq(ws):
    io = await ws.execute("cat /data/numbers.txt | sort | uniq")
    lines = (await io.stdout_str()).strip().split("\n")
    assert lines == ["1", "2", "3"]


@pytest.mark.asyncio
async def test_pipe_grep_wc(ws):
    io = await ws.execute("grep ERROR /data/log.txt | wc -l")
    assert (await io.stdout_str()).strip() == "2"


@pytest.mark.asyncio
async def test_pipe_head_stops_early(ws):
    io = await ws.execute("cat /data/big.txt | head -n 3")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 3
    assert lines[0] == "row 0"


@pytest.mark.asyncio
async def test_pipe_tail(ws):
    io = await ws.execute("cat /data/log.txt | tail -n 2")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 2
    assert lines[-1] == "INFO done"


@pytest.mark.asyncio
async def test_triple_pipe(ws):
    io = await ws.execute("cat /data/log.txt | grep INFO | head -n 2")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 2
    assert all("INFO" in line for line in lines)


# --- Control flow ---


@pytest.mark.asyncio
async def test_and_success(ws):
    io = await ws.execute("cat /data/hello.txt && echo done")
    assert b"done" in io.stdout


@pytest.mark.asyncio
async def test_and_failure_short_circuits(ws):
    io = await ws.execute(
        "grep NONEXISTENT /data/hello.txt && echo should_not_appear")
    assert b"should_not_appear" not in (io.stdout or b"")


@pytest.mark.asyncio
async def test_or_fallback(ws):
    io = await ws.execute("grep NONEXISTENT /data/hello.txt || echo fallback")
    assert b"fallback" in io.stdout


@pytest.mark.asyncio
async def test_semicolon_runs_both(ws):
    io = await ws.execute("echo first ; echo second")
    assert b"second" in io.stdout


# --- Redirects ---


@pytest.mark.asyncio
async def test_redirect_stdout_to_file(ws):
    await ws.execute("echo written > /data/out.txt")
    io = await ws.execute("cat /data/out.txt")
    assert b"written" in io.stdout


@pytest.mark.asyncio
async def test_redirect_append(ws):
    await ws.execute("echo line1 > /data/append.txt")
    await ws.execute("echo line2 >> /data/append.txt")
    io = await ws.execute("cat /data/append.txt")
    out = await io.stdout_str()
    assert "line1" in out
    assert "line2" in out


@pytest.mark.asyncio
async def test_redirect_on_or_chain(ws):
    io = await ws.execute("grep hello /data/hello.txt > /data/out.txt || "
                          "echo fallback > /data/out.txt; "
                          "cat /data/out.txt")
    assert "hello" in (await io.stdout_str())


@pytest.mark.asyncio
async def test_redirect_on_and_chain(ws):
    io = await ws.execute("echo first > /data/chain.txt && "
                          "echo second >> /data/chain.txt; "
                          "cat /data/chain.txt")
    assert "first" in (await io.stdout_str())
    assert "second" in (await io.stdout_str())


@pytest.mark.asyncio
async def test_redirect_stdin(ws):
    io = await ws.execute("grep world < /data/hello.txt")
    assert b"world" in io.stdout


@pytest.mark.asyncio
async def test_heredoc(ws):
    io = await ws.execute("cat << EOF\nhello heredoc\nEOF")
    assert b"hello heredoc" in io.stdout


# --- Subshell isolation ---


@pytest.mark.asyncio
async def test_subshell_cd_isolated(ws):
    await ws.execute("cd /data")
    await ws.execute("(cd /data/subdir)")
    assert ws.get_session(ws.default_session_id).cwd == "/data"


@pytest.mark.asyncio
async def test_subshell_export_isolated(ws):
    await ws.execute("(export LEAK=yes)")
    assert "LEAK" not in ws.get_session(ws.default_session_id).env


@pytest.mark.asyncio
async def test_subshell_inherits_parent_env(ws):
    await ws.execute("export INHERITED=true")
    io = await ws.execute("(printenv INHERITED)")
    assert b"true" in io.stdout


@pytest.mark.asyncio
async def test_nested_subshell(ws):
    await ws.execute("((export DEEP=yes))")
    assert "DEEP" not in ws.get_session(ws.default_session_id).env


# --- Background jobs ---


@pytest.mark.asyncio
async def test_background_basic(ws):
    await ws.execute("cat /data/hello.txt &")
    io = await ws.execute("wait %1")
    assert b"hello" in io.stdout


@pytest.mark.asyncio
async def test_background_isolation_env(ws):
    await ws.execute("export BG_VAR=leaked &")
    await ws.execute("wait %1")
    assert "BG_VAR" not in ws.get_session(ws.default_session_id).env


@pytest.mark.asyncio
async def test_background_isolation_cwd(ws):
    await ws.execute("cd /data &")
    await ws.execute("wait %1")
    assert ws.get_session(ws.default_session_id).cwd == "/"


@pytest.mark.asyncio
async def test_background_sees_parent_env(ws):
    await ws.execute("export VISIBLE=yes")
    await ws.execute("printenv VISIBLE &")
    io = await ws.execute("wait %1")
    assert b"yes" in io.stdout


# --- Session: cd + env ---


@pytest.mark.asyncio
async def test_cd_then_relative_cat(ws):
    await ws.execute("cd /data/subdir")
    io = await ws.execute("cat a.txt")
    assert b"aaa" in io.stdout


@pytest.mark.asyncio
async def test_cd_nested_relative(ws):
    await ws.execute("cd /data")
    await ws.execute("cd subdir")
    io = await ws.execute("cat b.txt")
    assert b"bbb" in io.stdout


@pytest.mark.asyncio
async def test_export_then_variable_expansion(ws):
    await ws.execute("export PATTERN=ERROR")
    io = await ws.execute("grep $PATTERN /data/log.txt | wc -l")
    assert (await io.stdout_str()).strip() == "2"


@pytest.mark.asyncio
async def test_export_unset_cycle(ws):
    await ws.execute("export TMP=val")
    assert ws.get_session(ws.default_session_id).env["TMP"] == "val"
    await ws.execute("unset TMP")
    assert "TMP" not in ws.get_session(ws.default_session_id).env


@pytest.mark.asyncio
async def test_printenv_shows_all(ws):
    await ws.execute("export A=1")
    await ws.execute("export B=2")
    io = await ws.execute("printenv")
    out = await io.stdout_str()
    assert "A=1" in out
    assert "B=2" in out


@pytest.mark.asyncio
async def test_printenv_single_key(ws):
    await ws.execute("export SECRET=abc")
    io = await ws.execute("printenv SECRET")
    assert (await io.stdout_str()).strip() == "abc"


@pytest.mark.asyncio
async def test_printenv_missing_key(ws):
    io = await ws.execute("printenv NOSUCH")
    assert io.exit_code == 1


# --- Multi-session isolation ---


@pytest.mark.asyncio
async def test_two_sessions_isolated_cwd(ws):
    sa = ws.create_session("s-a")
    sa.cwd = "/"
    sb = ws.create_session("s-b")
    sb.cwd = "/"
    await ws.execute("cd /data", session_id="s-a")
    await ws.execute("cd /data/subdir", session_id="s-b")
    assert sa.cwd == "/data"
    assert sb.cwd == "/data/subdir"


@pytest.mark.asyncio
async def test_two_sessions_isolated_env(ws):
    ws.create_session("s-a")
    ws.create_session("s-b")
    await ws.execute("export X=from_a", session_id="s-a")
    await ws.execute("export X=from_b", session_id="s-b")
    assert ws.get_session("s-a").env["X"] == "from_a"
    assert ws.get_session("s-b").env["X"] == "from_b"


@pytest.mark.asyncio
async def test_session_env_not_visible_cross_session(ws):
    ws.create_session("s-a")
    ws.create_session("s-b")
    await ws.execute("export PRIVATE=yes", session_id="s-a")
    io = await ws.execute("printenv PRIVATE", session_id="s-b")
    assert io.exit_code == 1


# --- For loops ---


@pytest.mark.asyncio
async def test_for_loop_basic(ws):
    io = await ws.execute(
        "for f in /data/subdir/a.txt /data/subdir/b.txt; do cat $f; done")
    out = await io.stdout_str()
    assert "aaa" in out
    assert "bbb" in out


@pytest.mark.asyncio
async def test_for_loop_variable_restored(ws):
    await ws.execute("export i=original")
    await ws.execute("for i in 1 2 3; do echo $i; done")
    assert ws.get_session(ws.default_session_id).env["i"] == "original"


# --- If/else ---


@pytest.mark.asyncio
async def test_if_true_branch(ws):
    io = await ws.execute(
        "if grep -q world /data/hello.txt; then echo found; else echo nope; fi"
    )
    assert b"found" in io.stdout


@pytest.mark.asyncio
async def test_if_false_branch(ws):
    io = await ws.execute(
        "if grep -q NOPE /data/hello.txt; then echo found; else echo nope; fi")
    assert b"nope" in io.stdout


# --- Complex combined ---


@pytest.mark.asyncio
async def test_cd_export_grep_pipe(ws):
    await ws.execute("cd /data")
    await ws.execute("export TERM=ERROR")
    io = await ws.execute("grep $TERM log.txt | wc -l")
    assert (await io.stdout_str()).strip() == "2"


@pytest.mark.asyncio
async def test_subshell_with_redirect(ws):
    await ws.execute("(echo from_subshell) > /data/sub_out.txt")
    io = await ws.execute("cat /data/sub_out.txt")
    assert b"from_subshell" in io.stdout


@pytest.mark.asyncio
async def test_pipe_into_redirect(ws):
    await ws.execute("grep ERROR /data/log.txt | sort > /data/errors.txt")
    io = await ws.execute("cat /data/errors.txt")
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 2
    assert lines[0] == "ERROR bad"
    assert lines[1] == "ERROR fail"


@pytest.mark.asyncio
async def test_background_with_pipe(ws):
    await ws.execute("cat /data/numbers.txt | sort | uniq &")
    io = await ws.execute("wait %1")
    lines = (await io.stdout_str()).strip().split("\n")
    assert sorted(lines) == ["1", "2", "3"]


@pytest.mark.asyncio
async def test_history_tracks_session_id(ws):
    ws.create_session("s-hist")
    ws.get_session("s-hist").cwd = "/"
    await ws.execute("echo tracked", session_id="s-hist")
    records = [e for e in await ws.history() if e["session"] == "s-hist"]
    assert len(records) == 1
    assert records[0]["command"] == "echo tracked"


# --- grep exit codes ---


@pytest.mark.asyncio
async def test_grep_no_match_exit_code(ws):
    io = await ws.execute("grep NONEXISTENT /data/hello.txt")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_match_exit_code(ws):
    io = await ws.execute("grep hello /data/hello.txt")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_q_match(ws):
    io = await ws.execute("grep -q world /data/hello.txt")
    assert io.exit_code == 0
    assert not (await io.stdout_str()).strip()


@pytest.mark.asyncio
async def test_grep_q_no_match(ws):
    io = await ws.execute("grep -q NONEXISTENT /data/hello.txt")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_and_short_circuit(ws):
    io = await ws.execute(
        "grep NONEXISTENT /data/hello.txt && echo should_not_appear")
    assert b"should_not_appear" not in (io.stdout or b"")


@pytest.mark.asyncio
async def test_grep_or_fallback(ws):
    io = await ws.execute("grep NONEXISTENT /data/hello.txt || echo fallback")
    assert b"fallback" in io.stdout


@pytest.mark.asyncio
async def test_grep_if_condition(ws):
    io = await ws.execute(
        "if grep -q world /data/hello.txt; then echo found; else echo nope; fi"
    )
    assert b"found" in io.stdout


@pytest.mark.asyncio
async def test_grep_if_no_match(ws):
    io = await ws.execute(
        "if grep -q NOPE /data/hello.txt; then echo found; else echo nope; fi")
    assert b"nope" in io.stdout


@pytest.mark.asyncio
async def test_grep_pipe_no_match_last_stage_wins(ws):
    io = await ws.execute("grep NONEXISTENT /data/hello.txt | sort")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_pipe_match(ws):
    io = await ws.execute("grep ERROR /data/log.txt | sort")
    assert io.exit_code == 0
    lines = (await io.stdout_str()).strip().split("\n")
    assert len(lines) == 2
    assert lines[0] == "ERROR bad"
    assert lines[1] == "ERROR fail"


@pytest.mark.asyncio
async def test_grep_no_match_then_or_chain(ws):
    io = await ws.execute(
        "grep NOPE /data/hello.txt || grep ERROR /data/log.txt | head -n 1")
    assert b"ERROR" in io.stdout


@pytest.mark.asyncio
async def test_grep_count_no_match(ws):
    io = await ws.execute("grep -c NONEXISTENT /data/hello.txt")
    assert (await io.stdout_str()).strip() == "0"


@pytest.mark.asyncio
async def test_grep_count_match(ws):
    io = await ws.execute("grep -c ERROR /data/log.txt")
    assert io.exit_code == 0
    assert (await io.stdout_str()).strip() == "2"


@pytest.mark.asyncio
async def test_grep_invert_match(ws):
    io = await ws.execute("grep -v ERROR /data/log.txt")
    assert io.exit_code == 0
    lines = (await io.stdout_str()).strip().split("\n")
    assert all("ERROR" not in line for line in lines)


@pytest.mark.asyncio
async def test_grep_invert_no_output(ws):
    io = await ws.execute("echo hello | grep -v hello")
    assert not (await io.stdout_str()).strip()


# --- rg exit codes ---


@pytest.mark.asyncio
async def test_rg_no_match_exit_code(ws):
    io = await ws.execute("rg NONEXISTENT /data/hello.txt")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_match_exit_code(ws):
    io = await ws.execute("rg hello /data/hello.txt")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_no_match_and_chain(ws):
    io = await ws.execute("rg NONEXISTENT /data/hello.txt && echo found")
    assert b"found" not in (io.stdout or b"")


@pytest.mark.asyncio
async def test_rg_no_match_or_chain(ws):
    io = await ws.execute("rg NONEXISTENT /data/hello.txt || echo fallback")
    assert b"fallback" in io.stdout


@pytest.mark.asyncio
async def test_rg_pipe_no_match(ws):
    io = await ws.execute("rg NONEXISTENT /data/hello.txt | wc -l")
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_match_pipe_head(ws):
    io = await ws.execute("rg INFO /data/log.txt | head -n 1")
    assert io.exit_code == 0
    assert b"INFO" in io.stdout


# --- diff exit codes ---


@pytest.mark.asyncio
async def test_diff_identical_files(ws):
    await ws.execute("echo same > /data/diff_a.txt")
    await ws.execute("echo same > /data/diff_b.txt")
    io = await ws.execute("diff /data/diff_a.txt /data/diff_b.txt")
    assert io.exit_code == 0
    assert not (await io.stdout_str()).strip()


@pytest.mark.asyncio
async def test_diff_different_files(ws):
    await ws.execute("echo aaa > /data/diff_a.txt")
    await ws.execute("echo bbb > /data/diff_b.txt")
    io = await ws.execute("diff /data/diff_a.txt /data/diff_b.txt")
    assert io.exit_code == 1
    assert (await io.stdout_str()).strip()


@pytest.mark.asyncio
async def test_diff_and_chain(ws):
    await ws.execute("echo same > /data/diff_a.txt")
    await ws.execute("echo same > /data/diff_b.txt")
    io = await ws.execute(
        "diff /data/diff_a.txt /data/diff_b.txt && echo identical")
    assert b"identical" in io.stdout


@pytest.mark.asyncio
async def test_diff_or_chain(ws):
    await ws.execute("echo aaa > /data/diff_a.txt")
    await ws.execute("echo bbb > /data/diff_b.txt")
    io = await ws.execute(
        "diff /data/diff_a.txt /data/diff_b.txt || echo different")
    assert b"different" in io.stdout


@pytest.mark.asyncio
async def test_diff_if_identical(ws):
    await ws.execute("echo same > /data/diff_a.txt")
    await ws.execute("echo same > /data/diff_b.txt")
    cmd = ("if diff /data/diff_a.txt /data/diff_b.txt;"
           " then echo same; else echo changed; fi")
    io = await ws.execute(cmd)
    assert b"same" in io.stdout


@pytest.mark.asyncio
async def test_diff_if_different(ws):
    await ws.execute("echo aaa > /data/diff_a.txt")
    await ws.execute("echo bbb > /data/diff_b.txt")
    cmd = ("if diff /data/diff_a.txt /data/diff_b.txt;"
           " then echo same; else echo changed; fi")
    io = await ws.execute(cmd)
    assert b"changed" in io.stdout


# --- find (verify already correct) ---


@pytest.mark.asyncio
async def test_find_existing(ws):
    io = await ws.execute("find /data/subdir")
    assert io.exit_code == 0
    assert b"a.txt" in io.stdout


@pytest.mark.asyncio
async def test_find_with_name(ws):
    io = await ws.execute("find /data/subdir -name a.txt")
    assert io.exit_code == 0
    assert b"a.txt" in io.stdout


# --- Complex combined scenarios ---


@pytest.mark.asyncio
async def test_grep_no_match_pipe_redirect(ws):
    cmd = ("grep NONEXISTENT /data/log.txt > /data/result.txt"
           " || echo none > /data/result.txt")
    await ws.execute(cmd)
    io = await ws.execute("cat /data/result.txt")
    assert b"none" in io.stdout


@pytest.mark.asyncio
async def test_grep_match_and_diff(ws):
    await ws.execute("grep ERROR /data/log.txt > /data/errors.txt")
    await ws.execute("echo 'ERROR fail\nERROR bad' > /data/expected.txt")
    io = await ws.execute("diff /data/errors.txt /data/expected.txt")
    assert io.exit_code in (0, 1)


@pytest.mark.asyncio
async def test_rg_subshell_isolation(ws):
    io = await ws.execute("(rg NONEXISTENT /data/hello.txt) || echo recovered")
    assert b"recovered" in io.stdout


@pytest.mark.asyncio
async def test_grep_background_exit_code(ws):
    await ws.execute("grep ERROR /data/log.txt &")
    io = await ws.execute("wait %1")
    assert io.exit_code == 0
    assert b"ERROR" in io.stdout


@pytest.mark.asyncio
async def test_grep_no_match_background(ws):
    await ws.execute("grep NONEXISTENT /data/log.txt &")
    io = await ws.execute("wait %1")
    assert io.exit_code == 1
