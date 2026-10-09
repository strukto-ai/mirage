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

import pytest

from mirage.cli.credentials import Login, write_login
from mirage.cli.settings import (
    DEFAULT_DAEMON_URL,
    config_path,
    get_config,
    is_local_url,
    list_config,
    load_daemon_settings,
    resolved_config,
    set_config,
    unset_config,
)
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_HOME


def test_load_daemon_settings_falls_back_to_token_file(tmp_path, monkeypatch):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    config_file = tmp_path / "config.toml"
    config_file.write_text("")
    token_file = tmp_path / "auth_token"
    token_file.write_text("file-token\n")
    settings = load_daemon_settings(path=config_file)
    assert settings.auth_token == "file-token"


def test_a_remote_url_never_takes_the_token_file(tmp_path, monkeypatch):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.setenv("MIRAGE_DAEMON_URL", "https://mirage.example.com")
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    config_file = tmp_path / "config.toml"
    config_file.write_text("")
    (tmp_path / "auth_token").write_text("file-token\n")
    settings = load_daemon_settings(path=config_file)
    assert settings.auth_token == ""


@pytest.mark.parametrize(
    "url, local",
    [
        ("http://127.0.0.1:8765", True),
        ("http://localhost:9100", True),
        ("http://[::1]:8765", True),
        ("https://mirage.example.com", False),
        ("http://10.0.0.5:8765", False),
        ("not a url", False),
    ],
)
def test_is_local_url(url, local):
    assert is_local_url(url) is local


def test_load_daemon_settings_env_wins_over_file(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_TOKEN", "from-env")
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    config_file = tmp_path / "config.toml"
    config_file.write_text("")
    token_file = tmp_path / "auth_token"
    token_file.write_text("from-file")
    settings = load_daemon_settings(path=config_file)
    assert settings.auth_token == "from-env"


def test_load_daemon_settings_config_wins_over_file(tmp_path, monkeypatch):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    config_file = tmp_path / "config.toml"
    config_file.write_text('[daemon]\nauth_token = "from-config"\n')
    token_file = tmp_path / "auth_token"
    token_file.write_text("from-file")
    settings = load_daemon_settings(path=config_file)
    assert settings.auth_token == "from-config"


def test_load_daemon_settings_no_sources_yields_empty_token(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    config_file = tmp_path / "config.toml"
    config_file.write_text("")
    settings = load_daemon_settings(path=config_file)
    assert settings.auth_token == ""


def test_config_path_follows_mirage_home(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert config_path() == tmp_path / "config.toml"


def test_load_daemon_settings_reads_config_under_mirage_home(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    (tmp_path / "config.toml").write_text(
        '[daemon]\nurl = "http://127.0.0.1:9999"\n'
    )
    settings = load_daemon_settings()
    assert settings.url == "http://127.0.0.1:9999"


def test_set_config_creates_file(tmp_path):
    p = tmp_path / "config.toml"
    set_config("socket", "/tmp/s.sock", path=p)
    assert get_config("socket", path=p) == "/tmp/s.sock"
    assert "[daemon]" in p.read_text()


def test_set_config_updates_existing_key(tmp_path):
    p = tmp_path / "config.toml"
    set_config("url", "http://a:1", path=p)
    set_config("url", "http://b:2", path=p)
    assert get_config("url", path=p) == "http://b:2"
    assert p.read_text().count("url =") == 1


def test_set_config_preserves_comments_and_other_keys(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text('[daemon]\n# keep me\nurl = "http://a:1"\n')
    set_config("socket", "/tmp/s.sock", path=p)
    text = p.read_text()
    assert "# keep me" in text
    assert 'url = "http://a:1"' in text
    assert get_config("socket", path=p) == "/tmp/s.sock"


def test_unset_config_removes_key(tmp_path):
    p = tmp_path / "config.toml"
    set_config("socket", "/tmp/s.sock", path=p)
    unset_config("socket", path=p)
    assert get_config("socket", path=p) is None


def test_list_config_returns_written_keys(tmp_path):
    p = tmp_path / "config.toml"
    set_config("url", "http://a:1", path=p)
    set_config("socket", "/tmp/s.sock", path=p)
    assert list_config(path=p) == {
        "url": "http://a:1",
        "socket": "/tmp/s.sock",
    }


def test_set_config_rejects_unknown_key(tmp_path):
    with pytest.raises(DaemonConfigError, match="unknown config key"):
        set_config("MIRAGE_HOME", "/x", path=tmp_path / "config.toml")


def test_numeric_key_written_bare(tmp_path):
    p = tmp_path / "config.toml"
    set_config("idle_grace_seconds", "45", path=p)
    assert "idle_grace_seconds = 45" in p.read_text()


def test_unset_config_accepts_unknown_key(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text('[daemon]\ntypo_key = "x"\nurl = "http://a:1"\n')
    unset_config("typo_key", path=p)
    assert "typo_key" not in p.read_text()
    assert 'url = "http://a:1"' in p.read_text()


def test_set_config_chmods_0600(tmp_path):
    p = tmp_path / "config.toml"
    set_config("auth_token", "s3cret", path=p)
    assert (p.stat().st_mode & 0o777) == 0o600


def test_unset_config_chmods_0600(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text('[daemon]\nurl = "http://a:1"\nsocket = "/tmp/s"\n')
    unset_config("socket", path=p)
    assert (p.stat().st_mode & 0o777) == 0o600


def test_load_daemon_settings_missing_explicit_path_returns_defaults(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    settings = load_daemon_settings(path=tmp_path / "nope.toml")
    assert settings.url == DEFAULT_DAEMON_URL


def test_resolved_config_reports_origins(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.setenv("MIRAGE_DAEMON_PORT", "9314")
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    (tmp_path / "config.toml").write_text(
        '[daemon]\nport = 9001\nurl = "http://f:1"\n'
    )
    resolved = resolved_config()
    assert resolved["port"] == ("9314", "env MIRAGE_DAEMON_PORT")
    assert resolved["url"] == ("http://f:1", "file")


def test_resolved_config_defaults_when_nothing_set(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    for name in (
        "MIRAGE_DAEMON_URL",
        "MIRAGE_TOKEN",
        "MIRAGE_DAEMON_PORT",
        "MIRAGE_IDLE_GRACE_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
    resolved = resolved_config()
    assert resolved["url"] == (DEFAULT_DAEMON_URL, "default")
    assert resolved["idle_grace_seconds"] == ("30", "default")


def test_resolved_config_includes_port(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv("MIRAGE_DAEMON_PORT", raising=False)
    resolved = resolved_config()
    assert resolved["port"] == ("8765", "default")
    monkeypatch.setenv("MIRAGE_DAEMON_PORT", "9100")
    assert resolved_config()["port"] == ("9100", "env MIRAGE_DAEMON_PORT")


def test_resolved_config_includes_the_ssh_endpoint(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    for name in (
        "MIRAGE_SSH_PORT",
        "MIRAGE_SSH_HOST",
        "MIRAGE_SSH_HOST_KEY_FILE",
        "MIRAGE_SSH_AUTHORIZED_KEYS",
    ):
        monkeypatch.delenv(name, raising=False)
    resolved = resolved_config()
    assert resolved["ssh_port"] == ("", "default")
    assert resolved["ssh_host"] == ("127.0.0.1", "default")
    assert resolved["ssh_authorized_keys"] == (
        str(tmp_path / "ssh" / "authorized_keys"),
        "default",
    )
    monkeypatch.setenv("MIRAGE_SSH_PORT", "2222")
    assert resolved_config()["ssh_port"] == ("2222", "env MIRAGE_SSH_PORT")


def _store_login(url: str) -> None:
    write_login(
        Login(url=url, access_token="from-login", logged_in_at=time.time())
    )


def test_a_login_for_this_url_comes_before_the_token_file(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.setenv("MIRAGE_DAEMON_URL", "http://127.0.0.1:8765/")
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    (tmp_path / "config.toml").write_text("")
    (tmp_path / "auth_token").write_text("file-token\n")
    _store_login("http://127.0.0.1:8765")
    settings = load_daemon_settings(path=tmp_path / "config.toml")
    assert settings.auth_token == ""
    assert settings.login is not None
    assert settings.login.access_token == "from-login"


def test_a_login_for_another_server_is_never_sent(tmp_path, monkeypatch):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.setenv("MIRAGE_DAEMON_URL", "https://mirage.example.com")
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    (tmp_path / "config.toml").write_text("")
    _store_login("https://other.example.com")
    settings = load_daemon_settings(path=tmp_path / "config.toml")
    assert settings.auth_token == ""
    assert settings.login is None


def test_a_set_token_comes_before_the_login(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_TOKEN", "from-env")
    monkeypatch.setenv("MIRAGE_DAEMON_URL", "https://mirage.example.com")
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    (tmp_path / "config.toml").write_text("")
    _store_login("https://mirage.example.com")
    settings = load_daemon_settings(path=tmp_path / "config.toml")
    assert settings.auth_token == "from-env"
    assert settings.login is None
