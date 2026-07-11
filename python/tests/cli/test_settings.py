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

from mirage.cli.settings import config_path, load_daemon_settings
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
        tmp_path, monkeypatch):
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
        tmp_path, monkeypatch):
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    monkeypatch.delenv("MIRAGE_DAEMON_URL", raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    (tmp_path /
     "config.toml").write_text('[daemon]\nurl = "http://127.0.0.1:9999"\n')
    settings = load_daemon_settings()
    assert settings.url == "http://127.0.0.1:9999"
