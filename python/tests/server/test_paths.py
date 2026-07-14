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

from mirage.server.env import ENV_HOME, ENV_PID_FILE
from mirage.server.paths import (PathOutsideRootError, mirage_home,
                                 pid_file_path, resolve_within_root,
                                 snapshot_root_path, validate_path_segment,
                                 version_root_path)


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
    monkeypatch.delenv(ENV_PID_FILE, raising=False)
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert pid_file_path() == tmp_path / "daemon.pid"


def test_pid_file_env_wins_over_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    monkeypatch.setenv(ENV_PID_FILE, "/run/mirage/daemon.pid")
    assert pid_file_path() == Path("/run/mirage/daemon.pid")


def test_pid_file_explicit_wins_over_env(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_PID_FILE, "/run/mirage/daemon.pid")
    assert pid_file_path(tmp_path / "x.pid") == tmp_path / "x.pid"


def test_roots_follow_mirage_home(monkeypatch, tmp_path):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert version_root_path() == tmp_path / "repos"
    assert snapshot_root_path() == tmp_path / "snapshots"


def test_mirage_home_relative_env_is_absolutized(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(ENV_HOME, "mhome")
    assert mirage_home() == tmp_path / "mhome"


def test_pid_file_relative_env_is_absolutized(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(ENV_PID_FILE, "rel/daemon.pid")
    assert pid_file_path() == tmp_path / "rel" / "daemon.pid"


def test_pid_file_explicit_relative_is_absolutized(monkeypatch, tmp_path):
    monkeypatch.delenv(ENV_PID_FILE, raising=False)
    monkeypatch.chdir(tmp_path)
    assert pid_file_path("x.pid") == tmp_path / "x.pid"


def _write_config(home, body):
    (home / "config.toml").write_text(f"[daemon]\n{body}\n")


def test_pid_file_config_beats_default(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_PID_FILE", raising=False)
    _write_config(tmp_path, 'pid_file = "/tmp/from-config.pid"')
    assert pid_file_path() == Path("/tmp/from-config.pid")


def test_pid_file_env_beats_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_PID_FILE", "/tmp/from-env.pid")
    _write_config(tmp_path, 'pid_file = "/tmp/from-config.pid"')
    assert pid_file_path() == Path("/tmp/from-env.pid")


def test_pid_file_explicit_beats_env(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_PID_FILE", "/tmp/from-env.pid")
    assert pid_file_path("/tmp/explicit.pid") == Path("/tmp/explicit.pid")


def test_pid_file_default_when_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_PID_FILE", raising=False)
    assert pid_file_path() == tmp_path / "daemon.pid"


def test_version_root_config_beats_default(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_VERSION_ROOT", raising=False)
    _write_config(tmp_path, 'version_root = "/data/repos"')
    assert version_root_path() == Path("/data/repos")


def test_version_root_env_beats_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_VERSION_ROOT", "/env/repos")
    _write_config(tmp_path, 'version_root = "/data/repos"')
    assert version_root_path() == Path("/env/repos")


def test_snapshot_root_config_beats_default(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_SNAPSHOT_ROOT", raising=False)
    _write_config(tmp_path, 'snapshot_root = "/data/snaps"')
    assert snapshot_root_path() == Path("/data/snaps")


def test_snapshot_root_default_when_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_SNAPSHOT_ROOT", raising=False)
    assert snapshot_root_path() == tmp_path / "snapshots"


def test_version_root_explicit_beats_env(monkeypatch):
    monkeypatch.setenv("MIRAGE_VERSION_ROOT", "/env/repos")
    assert version_root_path("/explicit/repos") == Path("/explicit/repos")


def test_version_root_default_when_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_VERSION_ROOT", raising=False)
    assert version_root_path() == tmp_path / "repos"


def test_snapshot_root_env_beats_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_SNAPSHOT_ROOT", "/env/snaps")
    _write_config(tmp_path, 'snapshot_root = "/data/snaps"')
    assert snapshot_root_path() == Path("/env/snaps")


def test_snapshot_root_explicit_beats_env(monkeypatch):
    monkeypatch.setenv("MIRAGE_SNAPSHOT_ROOT", "/env/snaps")
    assert snapshot_root_path("/explicit/snaps") == Path("/explicit/snaps")
