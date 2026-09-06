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


# ── unopenable redirect target (GNU bash 5.2.37 pinned) ─────
# bash answers both `cat < missing` and `echo x > /nosuchdir/f` with
# "bash: line 1: <target>: No such file or directory", exit 1, and
# never names the command. mirage drops the "bash: line N:" prefix,
# matching the house style of the other shell-attributed error
# ("nosuchcmd: command not found").


@pytest.mark.asyncio
async def test_stdin_missing_source_is_shell_attributed():
    ws = await _workspace()
    io = await ws.execute("cat < /data/missing")
    assert io.exit_code == 1
    assert (io.stderr or b"") == b"/data/missing: No such file or directory\n"


@pytest.mark.asyncio
async def test_stdin_missing_source_does_not_run_command():
    # bash never reaches the command, so `hi` is not printed and the
    # message is not prefixed with the command name.
    ws = await _workspace()
    io = await ws.execute("echo hi < /data/missing")
    assert io.exit_code == 1
    assert (io.stdout or b"") == b""
    assert (io.stderr or b"") == b"/data/missing: No such file or directory\n"


@pytest.mark.asyncio
async def test_stdin_missing_source_keeps_rest_of_line():
    # GNU: `cat < missing; echo next` prints next and exits 0 — the
    # redirect failure is not fatal to the line.
    ws = await _workspace()
    io = await ws.execute("cat < /data/missing; echo next")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"next\n"
    assert (io.stderr or b"") == b"/data/missing: No such file or directory\n"


@pytest.mark.asyncio
async def test_stdin_missing_source_short_circuits_and():
    ws = await _workspace()
    io = await ws.execute("cat < /data/missing && echo YES")
    assert io.exit_code == 1
    assert (io.stdout or b"") == b""


@pytest.mark.asyncio
async def test_stdin_missing_source_runs_or_branch():
    ws = await _workspace()
    io = await ws.execute("cat < /data/missing || echo OR")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"OR\n"


@pytest.mark.asyncio
async def test_stdin_missing_source_leaves_pipeline_running():
    # GNU: the failing element contributes nothing but `wc -l` still
    # runs, prints 0, and owns the pipeline's exit code.
    ws = await _workspace()
    io = await ws.execute("cat < /data/missing | wc -l")
    assert io.exit_code == 0
    assert (io.stdout or b"").strip() == b"0"
    assert (io.stderr or b"") == b"/data/missing: No such file or directory\n"


@pytest.mark.asyncio
async def test_stdin_missing_source_reported_as_typed():
    # GNU reports the target's spelling, not a resolved absolute path.
    ws = await _workspace()
    io = await ws.execute("cd /data && cat < missing")
    assert io.exit_code == 1
    assert (io.stderr or b"") == b"missing: No such file or directory\n"


@pytest.mark.asyncio
async def test_stdin_missing_source_stops_at_first_failure():
    # Two `<` redirects, the first missing: bash stops processing
    # redirects there, so exactly one message is emitted.
    ws = await _workspace()
    await ws.execute("printf PRE > /data/good")
    io = await ws.execute("cat < /data/missing < /data/good")
    assert io.exit_code == 1
    assert (io.stderr or b"") == b"/data/missing: No such file or directory\n"


@pytest.mark.asyncio
async def test_stdin_missing_source_skips_later_output_redirect():
    # `< missing > out` fails before `out` is created, like bash.
    ws = await _workspace()
    io = await ws.execute("echo hi < /data/missing > /data/late")
    assert io.exit_code == 1
    assert (await ws.execute("test -e /data/late")).exit_code == 1


@pytest.mark.asyncio
async def test_stdin_missing_source_does_not_prefix_first_word_of_line():
    # Regression: the failure used to unwind to the workspace-level
    # OSError handler, which stamped the line's first word onto the
    # message (`cd /data && cat < missing` reported "cd:").
    ws = await _workspace()
    io = await ws.execute("cd /data && cat < missing")
    stderr = (io.stderr or b"").decode()
    assert not stderr.startswith("cd:")
    assert not stderr.startswith("cat:")


@pytest.mark.asyncio
async def test_write_target_unwritable_is_shell_attributed():
    # The `>` side gets the same treatment as `<`: bash reports the
    # target, not the command, and not the backend's prose (which used
    # to surface as "echo: parent directory does not exist: /nodir").
    ws = await _workspace()
    io = await ws.execute("echo x > /nodir/f")
    assert io.exit_code == 1
    assert (io.stderr or b"") == b"/nodir/f: No such file or directory\n"


@pytest.mark.asyncio
async def test_write_target_unwritable_keeps_rest_of_line():
    # Regression: the write raised with no handler, so the whole line
    # died; GNU prints the error and runs `echo next`.
    ws = await _workspace()
    io = await ws.execute("echo x > /nodir/f; echo next")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"next\n"
    assert (io.stderr or b"") == b"/nodir/f: No such file or directory\n"


@pytest.mark.asyncio
async def test_write_target_unwritable_short_circuits_and():
    ws = await _workspace()
    io = await ws.execute("echo x > /nodir/f && echo YES")
    assert io.exit_code == 1
    assert (io.stdout or b"") == b""


@pytest.mark.asyncio
async def test_write_target_unwritable_runs_or_branch():
    ws = await _workspace()
    io = await ws.execute("echo x > /nodir/f || echo OR")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"OR\n"


@pytest.mark.asyncio
async def test_write_target_unwritable_stops_at_first_failure():
    # GNU stops processing redirects at the failed open, so the later
    # target is never created and only one message is emitted:
    #   $ echo x > /nodir/f > /data/out
    #   bash: line 1: /nodir/f: No such file or directory   # rc=1
    #   $ ls /data/out -> No such file or directory
    ws = await _workspace()
    io = await ws.execute("echo x > /nodir/f > /data/out")
    assert io.exit_code == 1
    assert (io.stderr or b"") == b"/nodir/f: No such file or directory\n"
    assert (await ws.execute("test -e /data/out")).exit_code == 1


@pytest.mark.asyncio
async def test_write_target_unwritable_keeps_earlier_target():
    # The mirror case: GNU already opened (and truncated) the earlier
    # target before the failing one, so it survives as an empty file.
    #   $ echo y > /data/out2 > /nodir/g
    #   bash: line 1: /nodir/g: No such file or directory   # rc=1
    #   $ ls -l /data/out2 -> 0 bytes
    ws = await _workspace()
    io = await ws.execute("echo y > /data/out2 > /nodir/g")
    assert io.exit_code == 1
    assert (io.stderr or b"") == b"/nodir/g: No such file or directory\n"
    assert (await ws.execute("test -e /data/out2")).exit_code == 0
    assert await _out(ws, "cat /data/out2") == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "echo x >> /nodir/f",
    "echo x 2> /nodir/f",
    "> /nodir/f",
])
async def test_write_target_unwritable_same_line_for_every_form(line: str):
    # GNU spells the append, stderr and command-less forms identically.
    ws = await _workspace()
    io = await ws.execute(line)
    assert io.exit_code == 1
    assert (io.stderr or b"") == b"/nodir/f: No such file or directory\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("line,expected", [
    ("cat 0<&1; echo rc=$?", ("rc=1\n", "cat: -: Bad file descriptor\n")),
    ("cat 0<&2; echo rc=$?", ("rc=1\n", "cat: -: Bad file descriptor\n")),
    ("cat <&-; echo rc=$?", ("rc=1\n", "cat: -: Bad file descriptor\n")),
    ("true 0<&1; echo rc=$?", ("rc=0\n", "")),
    ("echo hi 0<&1; echo rc=$?", ("hi\nrc=0\n", "")),
    ("read x 0<&1; echo rc=$?",
     ("rc=1\n", "bash: read: read error: 0: Bad file descriptor\n")),
])
async def test_stdin_from_a_closed_or_write_only_descriptor_is_unreadable(
        line, expected):
    # bash 5.2.37 opens the command all the same and the first read
    # fails with EBADF; a command that never reads succeeds. GNU cat's
    # `closing standard input` second line after `<&-` is not rendered.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute(line)
        assert (await io.stdout_str(), await io.stderr_str()) == expected
    finally:
        await ws.close()
