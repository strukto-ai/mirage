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

import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from mirage.cli import credentials
from mirage.cli.client import DaemonClient, DaemonUnreachable
from mirage.cli.credentials import Login, LoginError
from mirage.cli.settings import DaemonSettings
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
    with DaemonClient(DaemonSettings(url="https://mirage.invalid")) as client:
        with pytest.raises(DaemonUnreachable, match="mirage.invalid"):
            client.ensure_running()
    assert spawned == []
    assert not (tmp_path / "auth_token").exists()


def test_the_token_is_the_settings_own_else_the_login(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    login = Login(
        url="https://mirage.example.com",
        access_token="from-login",
        logged_in_at=time.time(),
    )
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
    with DaemonClient(DaemonSettings(url=login.url, login=login)) as client:
        with ThreadPoolExecutor(4) as pool:
            got = list(pool.map(lambda _: client.token(), range(4)))
    assert got == ["new"] * 4
    assert len(posted) == 1
