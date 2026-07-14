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

from typer.testing import CliRunner

from mirage.cli.config import app

runner = CliRunner()


def _isolate_home(monkeypatch, tmp_path):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_PID_FILE", raising=False)


def test_config_set_then_get(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    r = runner.invoke(app, ["set", "version_root", "/data/repos"])
    assert r.exit_code == 0
    r = runner.invoke(app, ["get", "version_root"])
    assert r.exit_code == 0
    assert "/data/repos" in r.stdout


def test_config_list(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    runner.invoke(app, ["set", "url", "http://a:1"])
    r = runner.invoke(app, ["list"])
    assert r.exit_code == 0
    assert "url" in r.stdout and "http://a:1" in r.stdout


def test_config_unset(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    runner.invoke(app, ["set", "socket", "/tmp/s.sock"])
    runner.invoke(app, ["unset", "socket"])
    r = runner.invoke(app, ["get", "socket"])
    assert r.exit_code != 0


def test_config_get_unset_exits_nonzero(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    r = runner.invoke(app, ["get", "pid_file"])
    assert r.exit_code != 0


def test_config_set_rejects_unknown_key(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    r = runner.invoke(app, ["set", "MIRAGE_HOME", "/x"])
    assert r.exit_code == 2


def test_config_set_unknown_key_message_is_clean(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    r = runner.invoke(app, ["set", "nope", "/x"])
    assert r.exit_code == 2
    assert "unknown config key" in r.output
    assert not r.output.strip().startswith("'")


def test_config_list_malformed_toml_fails_cleanly(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    (tmp_path / "config.toml").write_text("[daemon\nnot toml")
    r = runner.invoke(app, ["list"])
    assert r.exit_code == 2
    assert "malformed" in r.output
    assert "Traceback" not in r.output


def test_config_list_warns_on_unknown_keys(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    (tmp_path / "config.toml").write_text('[daemon]\ntypo_key = "x"\n')
    r = runner.invoke(app, ["list"])
    assert r.exit_code == 0
    assert "typo_key" in r.output
    assert "unknown" in r.output.lower()


def test_config_list_resolved_shows_origin(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    monkeypatch.setenv("MIRAGE_VERSION_ROOT", "/env/repos")
    r = runner.invoke(app, ["list", "--resolved"])
    assert r.exit_code == 0
    assert "/env/repos" in r.output
    assert "MIRAGE_VERSION_ROOT" in r.output


def test_config_list_resolved_masks_auth_token(monkeypatch, tmp_path):
    _isolate_home(monkeypatch, tmp_path)
    monkeypatch.setenv("MIRAGE_TOKEN", "supersecret")
    r = runner.invoke(app, ["list", "--resolved"])
    assert r.exit_code == 0
    assert "supersecret" not in r.output
    assert "***" in r.output
