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

import asyncssh
import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.server.ssh.login import login_env
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


def test_login_env_is_what_sshd_hands_a_login():
    env = login_env(StubProcess("xterm-256color"))
    assert env == {
        "USER": "demo",
        "LOGNAME": "demo",
        "SSH_CLIENT": "10.0.0.5 40000 2222",
        "SSH_CONNECTION": "10.0.0.5 40000 10.0.0.1 2222",
        "TERM": "xterm-256color",
    }
    assert "TERM" not in login_env(StubProcess(None))


@pytest.mark.asyncio
async def test_login_env_is_set_on_the_session(ssh):
    async with ssh.connect() as conn:
        fresh = await conn.run('echo "$HOME $USER $LOGNAME"; cd; pwd')
        made = await conn.run("mkdir -p /root; cd; pwd")
    assert (fresh.stdout, fresh.stderr) == (
        "/root demo demo\n/\n",
        "bash: line 1: cd: /root: No such file or directory\n",
    )
    assert made.stdout == "/root\n"


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
async def test_unknown_workspace_is_refused_by_name(ssh):
    async with ssh.connect(username="nope") as conn:
        result = await conn.run("echo hi")
    assert result.stderr == "mirage: no such workspace: nope\n"
    assert result.exit_status == 1


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
    assert sealed.exit_status == 126
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


@pytest.mark.asyncio
async def test_a_login_past_max_sessions_is_refused(ssh):
    ssh.registry.max_sessions = 1
    async with ssh.connect() as conn:
        result = await conn.run("echo never")
    assert result.exit_status == 1
    assert "workspace is at max_sessions (1)" in result.stderr


@pytest.mark.asyncio
async def test_a_login_while_the_server_shuts_down_is_refused(ssh):
    ssh.registry.draining = True
    async with ssh.connect() as conn:
        result = await conn.run("echo never")
    assert result.exit_status == 1
    assert "server is shutting down" in result.stderr
