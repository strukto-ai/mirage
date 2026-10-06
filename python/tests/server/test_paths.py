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

from pathlib import Path

from mirage.server.env import ENV_HOME
from mirage.server.paths import (
    mirage_home,
    pid_file_path,
    state_root_path,
)


def test_mirage_home_defaults_to_dot_mirage(monkeypatch):
    monkeypatch.delenv(ENV_HOME, raising=False)
    assert mirage_home() == Path.home() / ".mirage"


def test_mirage_home_honors_env(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert mirage_home() == tmp_path


def test_pid_file_defaults_under_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert pid_file_path() == tmp_path / "daemon.pid"


def test_pid_file_explicit_wins_over_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert pid_file_path(tmp_path / "x.pid") == tmp_path / "x.pid"


def test_state_root_follows_mirage_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert state_root_path() == tmp_path / "state"


def test_mirage_home_relative_env_is_absolutized(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(ENV_HOME, "mhome")
    assert mirage_home() == tmp_path / "mhome"


def test_pid_file_explicit_relative_is_absolutized(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    assert pid_file_path("x.pid") == tmp_path / "x.pid"


def test_state_root_explicit_beats_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert state_root_path("/explicit/state") == Path("/explicit/state")
