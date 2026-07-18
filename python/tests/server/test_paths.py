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

import pytest

from mirage.server.env import ENV_HOME
from mirage.server.paths import (PathOutsideRootError, mirage_home,
                                 pid_file_path, resolve_within_root,
                                 snapshot_root_path, state_root_path,
                                 validate_path_segment, version_root_path)


def test_resolve_within_root_relative(tmp_path):
    out = resolve_within_root(tmp_path, "seed.tar")
    assert out == (tmp_path / "seed.tar")


def test_resolve_within_root_absolute_inside(tmp_path):
    inside = tmp_path / "nested" / "a.tar"
    assert resolve_within_root(tmp_path, str(inside)) == inside


def test_resolve_within_root_returns_root(tmp_path):
    assert resolve_within_root(tmp_path, ".") == tmp_path


def test_resolve_within_root_rejects_traversal(tmp_path):
    with pytest.raises(PathOutsideRootError):
        resolve_within_root(tmp_path, "../../etc/passwd")


def test_resolve_within_root_rejects_absolute_outside(tmp_path):
    with pytest.raises(PathOutsideRootError):
        resolve_within_root(tmp_path, "/etc/passwd")


def test_resolve_within_root_rejects_sibling_prefix(tmp_path):
    sibling = str(tmp_path) + "-evil"
    with pytest.raises(PathOutsideRootError):
        resolve_within_root(tmp_path, sibling)


def test_validate_path_segment_accepts_safe():
    assert validate_path_segment("ws_abc123") == "ws_abc123"
    assert validate_path_segment("a.b-c_d") == "a.b-c_d"


@pytest.mark.parametrize("bad", ["", ".", "..", "a/b", "a\\b", "a b", "a$b"])
def test_validate_path_segment_rejects_bad(bad):
    with pytest.raises(PathOutsideRootError):
        validate_path_segment(bad)


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


def test_roots_follow_mirage_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert version_root_path() == tmp_path / "repos"
    assert snapshot_root_path() == tmp_path / "snapshots"
    assert state_root_path() == tmp_path / "state"


def test_mirage_home_relative_env_is_absolutized(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(ENV_HOME, "mhome")
    assert mirage_home() == tmp_path / "mhome"


def test_pid_file_explicit_relative_is_absolutized(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    assert pid_file_path("x.pid") == tmp_path / "x.pid"


def test_roots_explicit_beats_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert version_root_path("/explicit/repos") == Path("/explicit/repos")
    assert snapshot_root_path("/explicit/snaps") == Path("/explicit/snaps")
    assert state_root_path("/explicit/state") == Path("/explicit/state")
