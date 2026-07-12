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

from mirage.cli.client import DaemonClient
from mirage.cli.settings import DaemonSettings
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_HOME


def test_spawn_daemon_uses_mirage_home_for_log_and_token(
        tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    spawned = []
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen",
                        lambda *args, **kwargs: spawned.append(kwargs))
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
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen",
                        lambda *args, **kwargs: spawned.append(kwargs))
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
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen",
                        lambda cmd, **kwargs: _FakePopen(cmds, cmd, **kwargs))
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert "9100" in cmds[0]


def test_spawn_port_env_beats_config(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    monkeypatch.setenv("MIRAGE_DAEMON_PORT", "9200")
    (tmp_path / "config.toml").write_text("[daemon]\nport = 9100\n")
    cmds = []
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen",
                        lambda cmd, **kwargs: _FakePopen(cmds, cmd, **kwargs))
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert "9200" in cmds[0]


def test_spawn_port_falls_back_to_url(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    cmds = []
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen",
                        lambda cmd, **kwargs: _FakePopen(cmds, cmd, **kwargs))
    with DaemonClient(DaemonSettings(url="http://127.0.0.1:9331")) as client:
        client._spawn_daemon()
    assert "9331" in cmds[0]


def test_spawn_respects_config_auth_mode(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_AUTH_MODE", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    (tmp_path / "config.toml").write_text('[daemon]\nauth_mode = "token"\n')
    spawned = []
    monkeypatch.setattr("mirage.cli.client.subprocess.Popen",
                        lambda *args, **kwargs: spawned.append(kwargs))
    with DaemonClient(DaemonSettings()) as client:
        client._spawn_daemon()
    assert "MIRAGE_AUTH_MODE" not in spawned[0]["env"]
