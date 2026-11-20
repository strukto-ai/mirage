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
import time

import asyncssh
import pytest

from mirage.server.ssh import stream
from mirage.server.ssh.shell import ends_shell
from mirage.utils.abort import MirageAbortError, run_cancellable
from mirage.workspace.workspace import workspace as workspace_module


async def _read_until(
    process: asyncssh.SSHClientProcess, needle: str, seconds: float = 10.0
) -> str:
    seen = ""
    deadline = time.monotonic() + seconds
    while needle not in seen:
        left = deadline - time.monotonic()
        if left <= 0:
            raise AssertionError(f"never saw {needle!r} in {seen!r}")
        seen += await asyncio.wait_for(process.stdout.read(4096), left)
    return seen


@pytest.mark.parametrize(
    "line, leaves",
    [
        ("exit", True),
        ("  exit 3  ", True),
        ("exit 1 2", False),
        ("exitcode", False),
        ("echo exit", False),
        ("", False),
    ],
)
def test_ends_shell_reads_the_words(line, leaves):
    assert ends_shell(line) is leaves


@pytest.mark.asyncio
async def test_exec_returns_both_streams_and_the_status(ssh):
    async with ssh.connect() as conn:
        result = await conn.run("echo out; echo err >&2; exit 3")
    assert (result.stdout, result.stderr) == ("out\n", "err\n")
    assert result.exit_status == 3


@pytest.mark.asyncio
async def test_exec_reads_piped_stdin(ssh):
    async with ssh.connect() as conn:
        result = await conn.run(
            "cat > /notes && wc -l < /notes", input="a\nb\nc\n"
        )
    assert result.stdout.strip() == "3"


@pytest.mark.asyncio
async def test_exec_does_not_wait_for_stdin_it_never_reads(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process("echo quick")
        assert await _read_until(process, "quick") == "quick\n"
        await asyncio.wait_for(process.wait_closed(), 5)
    assert process.exit_status == 0


@pytest.mark.asyncio
async def test_each_channel_is_a_fresh_session(ssh):
    async with ssh.connect() as conn:
        await conn.run("mkdir -p /work && cd /work && export SEEN=1")
        result = await conn.run('pwd; echo "seen=${SEEN:-no}"')
    assert result.stdout == "/\nseen=no\n"


@pytest.mark.asyncio
async def test_channel_session_is_closed_when_the_channel_ends(ssh):
    async with ssh.connect() as conn:
        await conn.run("true")
    ids = [s.session_id for s in ssh.entry.runner.ws.list_sessions()]
    assert not [sid for sid in ids if sid.startswith("ssh_")]


@pytest.mark.asyncio
async def test_lines_are_recorded_in_history(ssh):
    async with ssh.connect() as conn:
        result = await conn.run(
            input="echo remembered\ncat /.bash_history\nexit\n"
        )
    assert "echo remembered" in result.stdout
    assert "export HOME" not in result.stdout


@pytest.mark.asyncio
async def test_shell_without_a_terminal_runs_lines_until_exit(ssh):
    async with ssh.connect() as conn:
        result = await conn.run(input="cd /\necho in\nexit 4\necho never\n")
    assert result.stdout == "in\n"
    assert result.exit_status == 4


@pytest.mark.asyncio
async def test_shell_without_a_terminal_ends_at_end_of_input(ssh):
    async with ssh.connect() as conn:
        result = await conn.run(input="false\n")
    assert (result.stdout, result.exit_status) == ("", 1)


@pytest.mark.asyncio
async def test_terminal_shell_prompts_with_the_cwd(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process(term_type="xterm")
        await _read_until(process, "mirage:/$ ")
        process.stdin.write("mkdir -p /up && cd /up\n")
        await _read_until(process, "mirage:/up$ ")
        process.stdin.write("exit 5\n")
        await asyncio.wait_for(process.wait_closed(), 5)
    assert process.exit_status == 5


@pytest.mark.asyncio
async def test_ctrl_c_interrupts_the_running_line(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process(term_type="xterm")
        await _read_until(process, "$ ")
        started = time.monotonic()
        process.stdin.write("sleep 30\n")
        await asyncio.sleep(0.5)
        process.stdin.write("\x03")
        seen = await _read_until(process, "^C")
        process.stdin.write("echo status=$?\n")
        seen += await _read_until(process, "status=130")
        process.stdin.write("exit\n")
        await asyncio.wait_for(process.wait_closed(), 5)
    assert time.monotonic() - started < 10
    assert "status=130" in seen


async def _slow_unwind(awaitable, cancel=None, stop=None):
    try:
        return await run_cancellable(awaitable, cancel, stop)
    except (asyncio.CancelledError, MirageAbortError):
        await asyncio.sleep(0.3)
        raise


def _put_back(session, snapshot, writer):
    session.last_exit_code = snapshot.last_exit_code


@pytest.mark.asyncio
async def test_ctrl_c_leaves_130_once_the_line_has_unwound(ssh, monkeypatch):
    # What an interrupted line leaves in `$?` as it unwinds, however late,
    # lands before the interrupt's 130.
    monkeypatch.setattr(workspace_module, "run_cancellable", _slow_unwind)
    monkeypatch.setattr(workspace_module, "restore_status", _put_back)
    async with ssh.connect() as conn:
        process = await conn.create_process(term_type="xterm")
        await _read_until(process, "$ ")
        process.stdin.write("sleep 30\n")
        await asyncio.sleep(0.5)
        process.stdin.write("\x03")
        await _read_until(process, "^C")
        await asyncio.sleep(0.6)
        process.stdin.write("echo status=$?\n")
        seen = await _read_until(process, "status=")
        seen += await _read_until(process, "\r\n")
        process.stdin.write("exit\n")
        await asyncio.wait_for(process.wait_closed(), 5)
    assert "status=130" in seen


@pytest.mark.asyncio
async def test_a_terminal_without_a_type_prompts_and_takes_ctrl_c(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process(request_pty="force")
        await _read_until(process, "mirage:/$ ")
        process.stdin.write("sleep 30\r")
        await asyncio.sleep(0.5)
        process.stdin.write("\x03")
        await _read_until(process, "^C")
        process.stdin.write("echo status=$?\r")
        seen = await _read_until(process, "status=130\r\n")
        process.stdin.write("exit\r")
        await asyncio.wait_for(process.wait_closed(), 5)
    assert "echo status=$?\r\n" in seen


@pytest.mark.asyncio
async def test_ctrl_c_at_the_prompt_drops_the_half_typed_line(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process(term_type="xterm")
        await _read_until(process, "$ ")
        process.stdin.write("echo never-run\x03")
        await _read_until(process, "^C")
        process.stdin.write("echo status=$?\n")
        await _read_until(process, "status=130")
        process.stdin.write("echo ran\n")
        seen = await _read_until(process, "ran\r\n")
        process.stdin.write("exit\n")
        await asyncio.wait_for(process.wait_closed(), 5)
    assert "never-run\r\n" not in seen
    assert "never-runecho" not in seen


async def _until_sessions_close(ssh, seconds: float = 10.0) -> float:
    started = time.monotonic()
    while True:
        ids = [s.session_id for s in ssh.entry.runner.ws.list_sessions()]
        if not [sid for sid in ids if sid.startswith("ssh_")]:
            return time.monotonic() - started
        assert time.monotonic() - started < seconds, "line outlived its client"
        await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_dropping_a_terminal_hangs_its_line_up(ssh):
    async with ssh.connect() as conn:
        await conn.create_process("sleep 30", term_type="xterm")
        await asyncio.sleep(0.3)
    await _until_sessions_close(ssh)


@pytest.mark.asyncio
async def test_a_line_without_a_terminal_runs_on_after_a_drop(ssh):
    async with ssh.connect() as conn:
        await conn.create_process("sleep 1; echo done > /ran")
        await asyncio.sleep(0.3)
    await _until_sessions_close(ssh)
    async with ssh.connect() as conn:
        assert (await conn.run("cat /ran")).stdout == "done\n"


@pytest.mark.asyncio
async def test_a_line_without_a_terminal_is_hung_up_when_it_writes(ssh):
    async with ssh.connect() as conn:
        await conn.create_process("sleep 1; echo out; sleep 30; touch /never")
        await asyncio.sleep(0.3)
    assert await _until_sessions_close(ssh) < 10
    async with ssh.connect() as conn:
        assert (await conn.run("ls /never")).exit_status != 0


@pytest.mark.asyncio
async def test_a_removed_workspace_ends_the_shell(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process()
        process.stdin.write("echo ready\n")
        ready = await asyncio.wait_for(process.stdout.readline(), 5)
        assert ready == "ready\n"
        await ssh.registry.remove("demo")
        process.stdin.write("echo hi\n")
        await asyncio.wait_for(process.wait_closed(), 5)
        err = await process.stderr.read()
    assert "the workspace is gone" in err


@pytest.mark.asyncio
async def test_unsupported_subsystem_is_refused(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process(subsystem="netconf")
        await asyncio.wait_for(process.wait_closed(), 5)
        err = await process.stderr.read()
    assert err == "mirage: unsupported subsystem: netconf\n"
    assert process.exit_status == 1


@pytest.mark.asyncio
async def test_oversized_plain_shell_line_is_refused(ssh, monkeypatch):
    monkeypatch.setattr(stream, "MAX_LINE", 16)
    async with ssh.connect() as conn:
        process = await conn.create_process()
        process.stdin.write("echo never" + "x" * 17)
        result = await asyncio.wait_for(process.wait(), 5)
        assert result.exit_status == 1
        assert result.stdout == ""
        assert "shell input line too long" in result.stderr


@pytest.mark.asyncio
async def test_terminal_editor_bounds_unsubmitted_input(ssh):
    async with ssh.connect() as conn:
        process = await conn.create_process(term_type="xterm")
        await _read_until(process, "$ ")
        process.stdin.write("x" * (stream.MAX_TERMINAL_LINE + 1))
        await _read_until(process, "\x07")
        process.stdin.write("\x15echo recovered\n")
        await _read_until(process, "recovered\r\n")
        process.stdin.write("exit\n")
        await asyncio.wait_for(process.wait_closed(), 5)
