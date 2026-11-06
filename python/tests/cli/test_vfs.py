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
from typer.testing import CliRunner

from mirage.cli import main as main_cli
from mirage.cli import vfs as vfs_cli
from mirage.cli.env import ENV_WORKSPACE


class _FakeResponse:
    status_code = 200
    content = b'["/a.py"]'

    def json(self) -> list[str]:
        return ["/a.py"]


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict | None]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ensure_running(self, allow_spawn: bool = False) -> None:
        return None

    def request(self, method, path, json=None, params=None):
        self.calls.append((method, path, json))
        return _FakeResponse()


@pytest.fixture
def fake(monkeypatch, tmp_path) -> _FakeClient:
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    client = _FakeClient()
    monkeypatch.setattr(vfs_cli, "make_client", lambda: client)
    monkeypatch.delenv(ENV_WORKSPACE, raising=False)
    return client


def test_a_call_runs_under_workspace_vfs(fake):
    result = CliRunner().invoke(
        main_cli.app, ["workspace", "vfs", "readdir", "/data", "-w", "demo"]
    )
    assert result.exit_code == 0, result.output
    assert fake.calls == [
        ("POST", "/v1/workspaces/demo/vfs/readdir", {"path": "/data"})
    ]


def test_glob_runs_under_workspace_vfs_from_the_environment(fake, monkeypatch):
    monkeypatch.setenv(ENV_WORKSPACE, "demo")
    result = CliRunner().invoke(
        main_cli.app, ["workspace", "vfs", "glob", "/**/*.py"]
    )
    assert result.exit_code == 0, result.output
    assert fake.calls == [
        ("POST", "/v1/workspaces/demo/glob", {"pattern": "/**/*.py"})
    ]
    assert result.stderr == ""


def test_the_old_glob_is_gone(fake):
    result = CliRunner().invoke(main_cli.app, ["glob", "*.py", "-w", "demo"])
    assert result.exit_code == 2
    assert fake.calls == []


def test_no_workspace_is_a_usage_failure(fake):
    result = CliRunner().invoke(
        main_cli.app, ["workspace", "vfs", "stat", "/"]
    )
    assert result.exit_code == 2
    assert "no workspace selected" in result.stderr
    assert fake.calls == []
