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

from mirage import RAMVFS, MountMode, Workspace
from mirage.server.ssh import stream
from mirage.server.ssh.session import ends_shell, login_env
from tests.server.ssh.conftest import (
    WORKSPACE_ID,
    bind_key,
    ram_workspace,
    start_harness,
    stop_harness,
    vault_workspace,
)


class StubProcess:
    def __init__(self, term_type: str | None) -> None:
        self.term_type = term_type

    def get_extra_info(self, name: str) -> str | tuple[str, int] | None:
        return {
            "username": "demo",
            "peername": ("10.0.0.5", 40000),
            "sockname": ("10.0.0.1", 2222),
        }[name]


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


def test_login_env_is_what_sshd_hands_a_login():
    env = login_env(StubProcess("xterm-256color"))
    assert env == {
        "HOME": "/",
        "USER": "demo",
        "LOGNAME": "demo",
        "SSH_CLIENT": "10.0.0.5 40000 2222",
        "SSH_CONNECTION": "10.0.0.5 40000 10.0.0.1 2222",
        "TERM": "xterm-256color",
    }
    assert "TERM" not in login_env(StubProcess(None))


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
async def test_login_env_is_set_on_the_session(ssh):
    async with ssh.connect() as conn:
        result = await conn.run('echo "$HOME $USER $LOGNAME"; cd; pwd')
    assert result.stdout == "/ demo demo\n/\n"


@pytest.mark.asyncio
async def test_a_profile_value_wins_over_the_login_default(tmp_path):
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={"agent": {"env": {"HOME": "/work"}}},
        profile="agent",
    )
    harness = await start_harness(tmp_path, ws)
    try:
        async with harness.connect() as conn:
            result = await conn.run('echo "$HOME $USER"')
    finally:
        await stop_harness(harness)
    assert result.stdout == "/work demo\n"


@pytest.mark.asyncio
async def test_lines_are_recorded_in_history(ssh):
    async with ssh.connect() as conn:
        await conn.run("echo remembered")
        result = await conn.run("cat /.bash_history")
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


@pytest.mark.asyncio
async def test_dropping_the_connection_cancels_the_line(ssh):
    async with ssh.connect() as conn:
        await conn.create_process("sleep 30")
        await asyncio.sleep(0.3)
    started = time.monotonic()
    while True:
        ids = [s.session_id for s in ssh.entry.runner.ws.list_sessions()]
        if not [sid for sid in ids if sid.startswith("ssh_")]:
            break
        assert time.monotonic() - started < 10, "line outlived its client"
        await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_unknown_workspace_is_refused_by_name(ssh):
    async with ssh.connect(username="nope") as conn:
        result = await conn.run("echo hi")
    assert result.stderr == "mirage: no such workspace: nope\n"
    assert result.exit_status == 1


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
async def test_failed_login_setup_closes_session(ssh, monkeypatch):
    ws = ssh.entry.runner.ws

    async def fail_export(*args, **kwargs):
        raise RuntimeError("login export failed")

    monkeypatch.setattr(ws, "shell", fail_export)
    async with ssh.connect() as conn:
        for _ in range(2):
            result = await conn.run("echo never")
            assert result.exit_status == 1
            assert "login export failed" in result.stderr
            assert not any(
                s.session_id.startswith("ssh_") for s in ws.list_sessions()
            )


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


@pytest.mark.asyncio
async def test_a_key_bound_to_a_profile_runs_under_it(tmp_path):
    harness = await start_harness(tmp_path, await vault_workspace())
    guarded = bind_key(harness, 'mirage-profile="guarded"')
    try:
        async with harness.connect() as conn:
            open_read = await conn.run("cat /vault/secret")
        async with harness.connect(key=guarded) as conn:
            sealed = await conn.run("cat /vault/secret")
    finally:
        await stop_harness(harness)
    assert open_read.stdout == "token\n"
    assert sealed.exit_status == 1
    assert "the vault is sealed" in sealed.stderr


@pytest.mark.asyncio
async def test_a_key_bound_to_an_account_opens_only_its_workspaces(tmp_path):
    harness = await start_harness(tmp_path)
    harness.registry.add(ram_workspace(), "mine", owner="alice")
    alice = bind_key(harness, 'mirage-account="alice"')
    try:
        async with harness.connect("mine", key=alice) as conn:
            own = await conn.run("echo mine")
        async with harness.connect(key=alice) as conn:
            other = await conn.run("echo never")
            async with conn.start_sftp_client() as sftp:
                with pytest.raises(asyncssh.SFTPNoSuchFile):
                    await sftp.listdir("/")
        async with harness.connect("mine") as conn:
            admin = await conn.run("echo admin")
    finally:
        await stop_harness(harness)
    assert own.stdout == "mine\n"
    assert other.exit_status == 1
    assert other.stderr == f"mirage: no such workspace: {WORKSPACE_ID}\n"
    assert admin.stdout == "admin\n"


@pytest.mark.asyncio
async def test_required_accounts_refuse_a_key_without_one(tmp_path):
    harness = await start_harness(tmp_path)
    harness.registry.accounts_required = True
    try:
        async with harness.connect() as conn:
            result = await conn.run("echo never")
    finally:
        await stop_harness(harness)
    assert result.exit_status == 1
    assert result.stderr == f"mirage: no such workspace: {WORKSPACE_ID}\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("options", "reason"),
    [
        ('mirage-profile="nope"', "nope"),
        ('mirage-profile="a",mirage-profile="b"', "exactly one profile"),
        ('mirage-profile=""', "exactly one profile"),
        ("mirage-profile", "exactly one profile"),
    ],
)
async def test_a_key_with_a_bad_profile_is_refused(tmp_path, options, reason):
    harness = await start_harness(tmp_path, await vault_workspace())
    bad = bind_key(harness, options)
    try:
        async with harness.connect(key=bad) as conn:
            result = await conn.run("echo never")
    finally:
        await stop_harness(harness)
    assert result.exit_status == 1
    assert result.stdout == ""
    assert "cannot open a session" in result.stderr
    assert reason in result.stderr
