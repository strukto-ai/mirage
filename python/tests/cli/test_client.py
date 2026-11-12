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

import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest

from mirage.cli import credentials
from mirage.cli.client import DaemonClient, DaemonUnreachable
from mirage.cli.credentials import (
    Login,
    LoginError,
    read_login,
    remove_login,
    write_login,
)
from mirage.cli.settings import DaemonSettings
from mirage.server.auth import storage as auth_storage
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_HOME


def test_spawn_daemon_uses_mirage_home_for_log_and_token(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    spawned = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda *args, **kwargs: spawned.append(kwargs),
    )
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert spawned, "daemon process must be spawned"
    assert (tmp_path / "daemon.log").exists()
    assert (tmp_path / "auth_token").exists()
    assert client.settings.auth_token


def test_spawn_daemon_rejects_bad_config(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    (tmp_path / "config.toml").write_text('[daemon]\ntypo_key = "x"\n')
    spawned = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda *args, **kwargs: spawned.append(kwargs),
    )
    with DaemonClient(DaemonSettings()) as client:
        with pytest.raises(DaemonConfigError, match="typo_key"):
            client._spawn_daemon()
    assert not spawned


class _FakePopen:
    def __init__(self, sink, cmd, **kwargs):
        sink.append(cmd)


def test_spawn_port_config_beats_url(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    (tmp_path / "config.toml").write_text("[daemon]\nport = 9100\n")
    cmds = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda cmd, **kwargs: _FakePopen(cmds, cmd, **kwargs),
    )
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert "9100" in cmds[0]


def test_spawn_port_env_beats_config(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    monkeypatch.setenv("MIRAGE_DAEMON_PORT", "9200")
    (tmp_path / "config.toml").write_text("[daemon]\nport = 9100\n")
    cmds = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda cmd, **kwargs: _FakePopen(cmds, cmd, **kwargs),
    )
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert "9200" in cmds[0]


def test_spawn_port_falls_back_to_url(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    cmds = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda cmd, **kwargs: _FakePopen(cmds, cmd, **kwargs),
    )
    with DaemonClient(DaemonSettings(url="http://127.0.0.1:9331")) as client:
        client._spawn_daemon()
    assert "9331" in cmds[0]


def test_spawn_respects_config_auth_mode(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    (tmp_path / "config.toml").write_text('[daemon]\nauth_mode = "token"\n')
    spawned = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda *args, **kwargs: spawned.append(kwargs),
    )
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert "MIRAGE_AUTH_MODE" not in spawned[0]["env"]


def test_a_remote_url_is_never_spawned(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    spawned = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda *args, **kwargs: spawned.append(kwargs),
    )
    monkeypatch.setattr(
        DaemonClient, "is_reachable", lambda self, timeout=0.5: False
    )
    with DaemonClient(DaemonSettings(url="https://mirage.invalid")) as client:
        with pytest.raises(DaemonUnreachable, match="mirage.invalid"):
            client.ensure_running()
    assert spawned == []
    assert not (tmp_path / "auth_token").exists()


def test_a_remote_server_slow_to_answer_is_waited_for(tmp_path, monkeypatch):
    # A server woken from idle answers after a second, past a local probe's
    # half second.
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.setattr("mirage.cli.client.is_local_url", lambda url: False)

    class Waking(BaseHTTPRequestHandler):
        def do_GET(self):
            time.sleep(1)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Waking)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with DaemonClient(DaemonSettings(url=url)) as client:
            client.ensure_running(allow_spawn=False)
    finally:
        server.shutdown()
        server.server_close()


def test_a_local_daemon_busy_past_the_first_probe_is_waited_for(
    tmp_path, monkeypatch
):
    # A daemon another command just spawned misses the half-second probe
    # and writes its token meanwhile; it holds its port, so the command
    # waits for it, spawns nothing and picks the token up.
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    spawned = []
    monkeypatch.setattr(
        "mirage.cli.client.subprocess.Popen",
        lambda *args, **kwargs: spawned.append(kwargs),
    )
    asked = []
    written = []

    class Busy(BaseHTTPRequestHandler):
        def do_GET(self):
            asked.append(self.path)
            if len(asked) == 1:
                written.append(
                    auth_storage.ensure_token_file(
                        auth_storage.default_token_file()
                    )
                )
                time.sleep(1)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Busy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with DaemonClient(DaemonSettings(url=url)) as client:
            client.ensure_running(allow_spawn=False)
            assert client.settings.auth_token == written[0]
    finally:
        server.shutdown()
        server.server_close()
    assert len(asked) >= 2
    assert spawned == []


class _GonePopen:
    """A spawned daemon that has already exited, as a crash leaves it."""

    returncode = 3

    def __init__(self, cmd, **kwargs):
        pass

    def poll(self):
        return self.returncode


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_a_daemon_that_exits_ends_the_wait(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen", _GonePopen)
    url = f"http://127.0.0.1:{_free_port()}"
    with DaemonClient(DaemonSettings(url=url)) as client:
        started = time.monotonic()
        with pytest.raises(DaemonUnreachable, match="exited with code 3"):
            client.ensure_running()
        assert time.monotonic() - started < 5


def test_a_daemon_that_lost_the_bind_waits_for_the_winner(
    tmp_path, monkeypatch
):
    # Two commands spawned at once: the loser exits on a held port while
    # the winner, already listening, is still starting up.
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    spawned = []

    def popen(cmd, **kwargs):
        spawned.append(cmd)
        return _GonePopen(cmd)

    monkeypatch.setattr("mirage.cli.client.subprocess.Popen", popen)
    # The winner binds only after this command's first look at the port.
    real = DaemonClient._listening
    looked = []

    def listening(self):
        looked.append(True)
        return len(looked) > 1 and real(self)

    monkeypatch.setattr(DaemonClient, "_listening", listening)
    asked = []

    class Starting(BaseHTTPRequestHandler):
        def do_GET(self):
            asked.append(self.path)
            self.send_response(200 if len(asked) > 3 else 503)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Starting)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with DaemonClient(DaemonSettings(url=url)) as client:
            client.ensure_running()
    finally:
        server.shutdown()
        server.server_close()
    assert asked[-1] == "/v1/health" and len(asked) == 4
    assert len(spawned) == 1


def test_the_token_is_the_settings_own_else_the_login(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    login = Login(
        url="https://mirage.example.com",
        access_token="from-login",
        logged_in_at=time.time(),
    )
    write_login(login)
    with DaemonClient(
        DaemonSettings(url=login.url, auth_token="set", login=login)
    ) as client:
        assert client.token() == "set"
    with DaemonClient(DaemonSettings(url=login.url, login=login)) as client:
        assert client.token() == "from-login"
        assert client._headers() == {"Authorization": "Bearer from-login"}
    with DaemonClient(DaemonSettings(url=login.url)) as client:
        assert client._headers() == {}


def test_an_ended_login_stops_the_command(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    login = Login(
        url="https://mirage.example.com",
        access_token="from-login",
        logged_in_at=time.time() - 31 * 24 * 60 * 60,
    )
    write_login(login)
    with DaemonClient(DaemonSettings(url=login.url, login=login)) as client:
        with pytest.raises(LoginError, match="30 days old"):
            client.token()


def test_requests_at_once_refresh_the_login_once(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    posted = []

    def post(url, data, timeout):
        posted.append(url)
        time.sleep(0.05)
        return httpx.Response(
            200,
            json={"access_token": "new", "expires_in": 86400},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(credentials.httpx, "post", post)
    login = Login(
        url="https://mirage.example.com",
        access_token="old",
        logged_in_at=time.time(),
        refresh_token="r1",
        expires_at=time.time() - 1,
        client_id="client_cli",
        token_endpoint="https://clerk.example.com/oauth/token",
    )
    write_login(login)
    with DaemonClient(DaemonSettings(url=login.url, login=login)) as client:
        with ThreadPoolExecutor(4) as pool:
            got = list(pool.map(lambda _: client.token(), range(4)))
    assert got == ["new"] * 4
    assert len(posted) == 1


def test_a_process_that_outlives_logout_stops_sending_the_login(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    posted = []

    def post(url, data, timeout):
        posted.append(url)
        return httpx.Response(
            200,
            json={"access_token": "new", "expires_in": 86400},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(credentials.httpx, "post", post)
    login = Login(
        url="https://mirage.example.com",
        access_token="old",
        logged_in_at=time.time(),
        refresh_token="r1",
        expires_at=time.time() - 1,
        client_id="client_cli",
        token_endpoint="https://clerk.example.com/oauth/token",
    )
    write_login(login)
    with DaemonClient(DaemonSettings(url=login.url, login=login)) as client:
        remove_login()
        with pytest.raises(LoginError, match="not logged in to"):
            client.token()
    assert posted == []
    assert read_login() is None


def test_a_new_login_stops_a_client_bound_to_the_old_one(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    first = Login(
        url="https://mirage.example.com",
        access_token="alice",
        logged_in_at=time.time() - 60,
    )
    write_login(first)
    with DaemonClient(DaemonSettings(url=first.url, login=first)) as client:
        assert client.token() == "alice"
        assert client.held == "alice"
        write_login(
            Login(url=first.url, access_token="bob", logged_in_at=time.time())
        )
        with pytest.raises(LoginError, match="changed"):
            client.token()
