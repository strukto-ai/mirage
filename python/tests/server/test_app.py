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

import os

from mirage.server.app import _remove_pid_file, _write_pid_file, build_app
from mirage.server.env import ENV_HOME, ENV_PID_FILE


def test_build_app_pid_file_explicit_wins(tmp_path):
    target = tmp_path / "custom" / "daemon.pid"
    app = build_app(pid_file=target)
    assert app.state.pid_file == target


def test_build_app_pid_file_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_PID_FILE, str(tmp_path / "env.pid"))
    app = build_app()
    assert app.state.pid_file == tmp_path / "env.pid"


def test_build_app_roots_follow_mirage_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.delenv(ENV_PID_FILE, raising=False)
    app = build_app()
    assert app.state.pid_file == tmp_path / "daemon.pid"
    assert app.state.snapshot_root == tmp_path / "snapshots"


def test_write_and_remove_pid_file_creates_parents(tmp_path):
    target = tmp_path / "nested" / "daemon.pid"
    _write_pid_file(target)
    assert target.read_text() == str(os.getpid())
    _remove_pid_file(target)
    assert not target.exists()


def test_remove_pid_file_missing_is_quiet(tmp_path):
    _remove_pid_file(tmp_path / "does_not_exist.pid")
