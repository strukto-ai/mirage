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
import errno
import os
import signal
import socket
import sys

import asyncssh
import pytest
from httpx import ASGITransport, AsyncClient, ConnectError

from mirage.server import app as app_module
from mirage.server import metrics as metrics_module
from mirage.server.app import (
    _remove_pid_file,
    _watch_exit,
    _write_pid_file,
    build_app,
)
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_E2B_PORT, ENV_HOME
from mirage.server.ssh.config import SSHConfig
from mirage.server.ssh.errors import SSHConfigError
from tests.server.routers.e2b_test_support import (
    CREATE,
    KEY,
    PROCESS,
    TOKEN,
    data_headers,
    start_body,
)


def test_build_app_pid_file_explicit_wins(tmp_path):
    target = tmp_path / "custom" / "daemon.pid"
    app = build_app(pid_file=target)
    assert app.state.pid_file == target


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


def test_build_app_keeps_the_ssh_endpoint_shut_by_default(tmp_path):
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
async def test_a_configured_entry_point_without_asyncssh_fails_the_start(
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
    assert app.state.registry not in metrics_module._registries


@pytest.mark.asyncio
async def test_the_lifespan_lets_a_running_line_finish_before_it_closes():
    app = build_app(idle_grace_seconds=10.0, graceful_timeout=5)
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            r = await client.post(
                "/v1/workspaces",
                json={
                    "id": "d",
                    "config": {
                        "mounts": {"/": {"vfs": "ram", "mode": "write"}}
                    },
                },
            )
            assert r.status_code == 201, r.text
        runner = app.state.registry.get("d").runner
        line = asyncio.ensure_future(
            runner.call(runner.ws.shell("sleep 0.3; echo done"))
        )
        await asyncio.sleep(0.05)
    assert app.state.registry.draining
    assert (await (await line).stdout_str()) == "done\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("timeout", [0, 5])
async def test_a_signal_drains_before_the_servers_handler_stops_it(
    monkeypatch,
    timeout,
):
    app = build_app(
        idle_grace_seconds=10.0, graceful_timeout=timeout, e2b_port=8766
    )
    stopped = []
    installed = {}
    monkeypatch.setattr(
        signal,
        "getsignal",
        lambda signum: lambda sig, frame: stopped.append(sig),
    )
    monkeypatch.setattr(signal, "signal", installed.__setitem__)
    wrapped = app_module._drain_on_signals(app)
    assert set(wrapped) == set(installed) == {signal.SIGTERM, signal.SIGINT}
    installed[signal.SIGTERM](signal.SIGTERM, None)
    installed[signal.SIGINT](signal.SIGINT, None)
    await asyncio.sleep(0)
    await app.state.drain_task
    assert app.state.registry.draining
    assert stopped == [signal.SIGTERM]


@pytest.mark.asyncio
async def test_without_a_graceful_timeout_the_servers_handlers_stay(
    monkeypatch,
):
    app = build_app(idle_grace_seconds=10.0, e2b_port=False)
    installed = {}
    monkeypatch.setattr(signal, "signal", installed.__setitem__)
    assert app_module._drain_on_signals(app) == {}
    assert installed == {}


@pytest.mark.asyncio
async def test_the_lifespan_puts_the_servers_handlers_back():
    before = signal.getsignal(signal.SIGINT)
    app = build_app(idle_grace_seconds=10.0, graceful_timeout=5)
    async with app.router.lifespan_context(app):
        assert signal.getsignal(signal.SIGINT) is not before
    assert signal.getsignal(signal.SIGINT) is before


@pytest.mark.asyncio
async def test_every_close_marks_the_server_shutting_down():
    app = build_app(idle_grace_seconds=10.0)
    async with app.router.lifespan_context(app):
        assert not app.state.registry.draining
        assert app.state.registry in metrics_module._registries
    assert app.state.registry.draining
    assert app.state.registry not in metrics_module._registries


@pytest.mark.asyncio
async def test_metrics_report_the_work_a_shutdown_waits_for(monkeypatch):
    app = build_app(idle_grace_seconds=10.0, graceful_timeout=5)
    seen = []
    drain = app.state.registry.drain

    async def watched(seconds: float) -> None:
        seen.append(app.state.registry in metrics_module._registries)
        await drain(seconds)

    monkeypatch.setattr(app.state.registry, "drain", watched)
    async with app.router.lifespan_context(app):
        pass
    assert seen == [True]
    assert app.state.registry not in metrics_module._registries


@pytest.mark.asyncio
async def test_a_failed_close_still_stops_reporting_metrics(monkeypatch):
    app = build_app(idle_grace_seconds=10.0)
    monkeypatch.setattr(app.state.registry, "close_all", _failing_close)
    with pytest.raises(RuntimeError, match="close failed"):
        async with app.router.lifespan_context(app):
            pass
    assert app.state.registry not in metrics_module._registries


async def _failing_close() -> None:
    raise RuntimeError("close failed")


@pytest.mark.parametrize("port", ["", "0", "-1", "65536", "8766.0", "many"])
def test_e2b_port_rejects_invalid_values(monkeypatch, port):
    monkeypatch.setenv(ENV_E2B_PORT, port)
    with pytest.raises(DaemonConfigError, match=ENV_E2B_PORT):
        build_app()


@pytest.mark.asyncio
async def test_e2b_bind_failure_keeps_existing_pid_file(tmp_path):
    pid_file = tmp_path / "daemon.pid"
    pid_file.write_text("preserved")
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        app = build_app(
            auth_config=TOKEN,
            e2b_port=occupied.getsockname()[1],
            pid_file=pid_file,
        )
        with pytest.raises(OSError) as error:
            async with app.router.lifespan_context(app):
                pytest.fail("startup succeeded with an occupied E2B port")
        assert error.value.errno == errno.EADDRINUSE
    assert pid_file.read_text() == "preserved"
    assert app.state.registry not in metrics_module._registries


@pytest.mark.asyncio
async def test_live_e2b_listener_shares_registry_and_releases_http_on_sigterm():
    loopback = "127.0.0.1"
    with socket.socket() as native, socket.socket() as companion:
        native.bind((loopback, 0))
        companion.bind((loopback, 0))
        native_port = native.getsockname()[1]
        e2b_port = companion.getsockname()[1]
    native_base = f"http://{loopback}:{native_port}"
    e2b_base = f"http://{loopback}:{e2b_port}"
    server = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import sys, uvicorn; from mirage.server import build_app; "
        "uvicorn.run(build_app(), host='127.0.0.1', port=int(sys.argv[1]))",
        str(native_port),
        env={
            **os.environ,
            ENV_E2B_PORT: str(e2b_port),
            "MIRAGE_AUTH_MODE": "token",
            "MIRAGE_AUTH_TOKEN": KEY["X-API-Key"],
        },
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        async with AsyncClient(trust_env=False) as client:
            async with asyncio.timeout(10):
                while True:
                    if server.returncode is not None:
                        pytest.fail((await server.stdout.read()).decode())
                    try:
                        response = await client.get(native_base + "/v1/health")
                    except ConnectError:
                        await asyncio.sleep(0.03)
                    else:
                        assert response.status_code == 200
                        break

            bearer = {"Authorization": f"Bearer {KEY['X-API-Key']}"}
            native_denied = await client.get(
                native_base + "/v1/workspaces", headers=KEY
            )
            assert native_denied.status_code == 401
            assert native_denied.json()["error"]["code"] == "unauthorized"
            assert native_denied.headers["WWW-Authenticate"] == "Bearer"
            sandbox_denied = await client.post(
                e2b_base + CREATE, headers=bearer
            )
            assert sandbox_denied.status_code == 401
            assert sandbox_denied.json() == {
                "code": 401,
                "message": "unauthorized",
            }
            assert "WWW-Authenticate" not in sandbox_denied.headers
            assert (
                await client.post(native_base + CREATE, headers=bearer)
            ).status_code == 404
            assert (
                await client.get(e2b_base + "/v1/health")
            ).status_code == 404

            created = await client.post(e2b_base + CREATE, headers=KEY)
            assert created.status_code == 201, created.text
            sandbox = created.json()
            headers = data_headers(sandbox)
            found = await client.get(
                f"{native_base}/v1/workspaces/{sandbox['sandboxID']}",
                headers=bearer,
            )
            assert found.status_code == 200, found.text
            reader, writer = await asyncio.open_connection(loopback, e2b_port)
            try:
                request_headers = {
                    **headers,
                    "Host": f"{loopback}:{e2b_port}",
                    "Content-Length": "100",
                    "Expect": "100-continue",
                }
                request = f"POST {PROCESS} HTTP/1.1\r\n" + "".join(
                    f"{key}: {value}\r\n"
                    for key, value in request_headers.items()
                )
                writer.write((request + "\r\n").encode())
                await writer.drain()
                async with asyncio.timeout(5):
                    assert b"100 Continue" in await reader.readuntil(
                        b"\r\n\r\n"
                    )
                    async with client.stream(
                        "POST",
                        e2b_base + PROCESS,
                        headers=headers,
                        content=start_body("printf ready; sleep 30"),
                    ) as stream:
                        assert stream.status_code == 200
                        chunks = stream.aiter_bytes()
                        started = bytearray()
                        while b"cmVhZHk=" not in started:
                            started.extend(await anext(chunks))
                        server.terminate()
                        assert b"401 Unauthorized" in await reader.readuntil(
                            b"\r\n\r\n"
                        )
                        async for _ in chunks:
                            pass
                    await server.wait()
            finally:
                writer.close()
                await writer.wait_closed()
            for port in (native_port, e2b_port):
                with pytest.raises(OSError):
                    await asyncio.open_connection(loopback, port)
    finally:
        if server.returncode is None:
            server.kill()
            await server.wait()
