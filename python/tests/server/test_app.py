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
import os

import asyncssh
import pytest
from httpx import ASGITransport, AsyncClient

from mirage.execution.ram import RAMExecutionStore
from mirage.server import app as app_module
from mirage.server.app import (
    _remove_pid_file,
    _watch_exit,
    _write_pid_file,
    build_app,
)
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_HOME
from mirage.server.ssh.config import SSHConfig
from mirage.server.ssh.errors import SSHConfigError


def test_build_app_pid_file_explicit_wins(tmp_path):
    target = tmp_path / "custom" / "daemon.pid"
    app = build_app(pid_file=target)
    assert app.state.pid_file == target


@pytest.mark.asyncio
async def test_build_app_borrows_injected_execution_store(tmp_path):
    store = RAMExecutionStore()
    app = build_app(state_root=tmp_path, execution_store=store)
    assert app.state.jobs.store is store
    async with app.router.lifespan_context(app):
        assert await store.list() == []
    assert await store.list() == []
    await store.close()


def test_build_app_roots_follow_mirage_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    app = build_app()
    assert app.state.pid_file is None
    assert app.state.on_idle_exit is None
    assert app.state.state_root == tmp_path / "state"


def test_write_and_remove_pid_file_creates_parents(tmp_path):
    target = tmp_path / "nested" / "daemon.pid"
    _write_pid_file(target)
    assert target.read_text() == str(os.getpid())
    _remove_pid_file(target)
    assert not target.exists()


def test_remove_pid_file_missing_is_quiet(tmp_path):
    _remove_pid_file(tmp_path / "does_not_exist.pid")


@pytest.mark.asyncio
async def test_watch_exit_calls_the_hook_once_the_event_is_set():
    event = asyncio.Event()
    calls: list[str] = []
    watcher = asyncio.create_task(
        _watch_exit(event, lambda: calls.append("exit"))
    )
    await asyncio.sleep(0)
    assert calls == []
    event.set()
    await watcher
    assert calls == ["exit"]


def test_build_app_rejects_unknown_config_key(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    (tmp_path / "config.toml").write_text('[daemon]\ntypo_key = "x"\n')
    with pytest.raises(DaemonConfigError, match="typo_key"):
        build_app()


def test_build_app_accepts_valid_config(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    (tmp_path / "config.toml").write_text('[daemon]\nurl = "http://h:1"\n')
    build_app()


def _ssh_config(tmp_path, key: asyncssh.SSHKey) -> SSHConfig:
    authorized = tmp_path / "authorized_keys"
    authorized.write_bytes(key.export_public_key())
    return SSHConfig(
        port=0,
        host="127.0.0.1",
        host_key_file=tmp_path / "host_key",
        authorized_keys_file=authorized,
    )


def test_build_app_keeps_the_ssh_door_shut_by_default(tmp_path):
    app = build_app(pid_file=tmp_path / "daemon.pid")
    assert app.state.ssh_config.port is None


@pytest.mark.asyncio
async def test_lifespan_serves_http_workspaces_over_ssh(tmp_path):
    key = asyncssh.generate_private_key("ssh-ed25519")
    app = build_app(
        pid_file=tmp_path / "daemon.pid", ssh_config=_ssh_config(tmp_path, key)
    )
    async with app.router.lifespan_context(app):
        port = app.state.ssh.get_port()
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            r = await client.post(
                "/v1/workspaces",
                json={
                    "config": {
                        "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}
                    }
                },
            )
            wid = r.json()["id"]
            async with asyncssh.connect(
                "127.0.0.1",
                port,
                username=wid,
                client_keys=[key],
                known_hosts=None,
            ) as conn:
                result = await conn.run("echo over-ssh > /f && cat /f")
            r = await client.post(
                f"/v1/workspaces/{wid}/shell", json={"command": "cat /f"}
            )
    assert result.stdout == "over-ssh\n"
    assert r.json()["stdout"] == "over-ssh\n"
    with pytest.raises(OSError):
        await asyncssh.connect(
            "127.0.0.1",
            port,
            username=wid,
            client_keys=[key],
            known_hosts=None,
        )


@pytest.mark.asyncio
async def test_a_configured_door_without_asyncssh_fails_the_start(
    monkeypatch, tmp_path
):
    key = asyncssh.generate_private_key("ssh-ed25519")
    app = build_app(
        pid_file=tmp_path / "daemon.pid", ssh_config=_ssh_config(tmp_path, key)
    )

    def missing(name: str) -> None:
        raise ModuleNotFoundError(f"No module named {name!r}")

    monkeypatch.setattr(app_module.importlib, "import_module", missing)
    with pytest.raises(SSHConfigError, match="ssh extra"):
        async with app.router.lifespan_context(app):
            pass
    assert not (tmp_path / "daemon.pid").exists()
