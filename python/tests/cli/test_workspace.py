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

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from mirage.cli import workspace as workspace_cli
from mirage.cli.workspace import _resolve_config_arg

OVERRIDE = """
mounts:
  /wiki:
    vfs: ./backends/wiki.py:WikiVFS
  /pkg:
    vfs: my_pkg.backends:WikiVFS
  /ram:
    vfs: ram
clis:
  tally:
    cli: ../tools/tally.py:TALLY
"""


@pytest.mark.parametrize(
    "resolve", [workspace_cli.resolve_config, _resolve_config_arg]
)
def test_exponent_ttl_reaches_the_daemon_as_a_number(tmp_path, resolve):
    path = tmp_path / "workspace.yaml"
    path.write_text("mounts: {/d: {vfs: ram, read: bounded, ttl: 1e3}}\n")
    assert resolve(path)["mounts"]["/d"]["ttl"] == 1000


def test_a_load_override_rebases_relative_code_refs_onto_its_dir(
    tmp_path: Path,
):
    # `create` always did this; `load` and `clone` read their config
    # through this function and used to send the refs as spelled, so
    # the daemon resolved them against its own cwd and answered 500.
    deploy = tmp_path / "deploy"
    deploy.mkdir()
    path = deploy / "override.yaml"
    path.write_text(OVERRIDE)
    resolved = _resolve_config_arg(path)
    mounts = resolved["mounts"]
    assert mounts["/wiki"]["vfs"] == (f"{deploy}/backends/wiki.py:WikiVFS")
    # A module dotpath is importlib's to resolve, and a builtin name is
    # not a reference at all: both pass through untouched.
    assert mounts["/pkg"]["vfs"] == "my_pkg.backends:WikiVFS"
    assert mounts["/ram"]["vfs"] == "ram"
    assert resolved["clis"]["tally"]["cli"] == (
        f"{deploy}/../tools/tally.py:TALLY"
    )


class _FakeResponse:
    def __init__(self, status_code: int, content: bytes) -> None:
        self.status_code = status_code
        self.content = content

    def json(self) -> Any:
        return json.loads(self.content)


class _FakeClient:
    def __init__(self, answer: _FakeResponse) -> None:
        self.answer = answer
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ensure_running(self, allow_spawn: bool = True) -> None:
        return None

    def request(self, method: str, path: str, **kwargs: Any):
        files = kwargs.get("files")
        if files is not None:
            kwargs["files"] = {
                name: (part[0], part[1], part[2])
                if isinstance(part[1], str)
                else (part[0], part[1].read(), part[2])
                for name, part in files.items()
            }
        self.calls.append((method, path, kwargs))
        return self.answer


@pytest.fixture()
def fake(monkeypatch):
    detail = b'{"id": "w2", "mounts": [], "sessions": [], "created_at": 0}'
    client = _FakeClient(_FakeResponse(201, detail))
    monkeypatch.setattr(workspace_cli, "make_client", lambda: client)
    return client


def _invoke(*args: str):
    return CliRunner().invoke(workspace_cli.app, list(args))


def test_snapshot_writes_the_answered_tar_here(fake, tmp_path):
    fake.answer = _FakeResponse(200, b"TAR")
    out = tmp_path / "w.tar"
    result = _invoke("snapshot", "w", str(out))
    assert result.exit_code == 0, result.output
    assert out.read_bytes() == b"TAR"
    assert fake.calls[0][:2] == ("GET", "/v1/workspaces/w/snapshot")


def test_snapshot_with_a_key_goes_to_the_store(fake):
    fake.answer = _FakeResponse(200, b'{"id": "w", "key": "a.tar", "size": 3}')
    result = _invoke("snapshot", "w", "--key", "a.tar")
    assert result.exit_code == 0, result.output
    method, path, kwargs = fake.calls[0]
    assert (method, path, kwargs["json"]) == (
        "POST",
        "/v1/workspaces/w/snapshot",
        {"key": "a.tar"},
    )


@pytest.mark.parametrize("args", [["w"], ["w", "out.tar", "--key", "k"]])
def test_snapshot_takes_a_file_or_a_key(fake, args):
    assert _invoke("snapshot", *args).exit_code == 2
    assert fake.calls == []


def test_load_uploads_the_file(fake, tmp_path):
    tar = tmp_path / "w.tar"
    tar.write_bytes(b"TAR")
    result = _invoke("load", str(tar), "--id", "w2")
    assert result.exit_code == 0, result.output
    method, path, kwargs = fake.calls[0]
    assert (method, path) == ("POST", "/v1/workspaces/load")
    assert kwargs["files"]["request"][1] == '{"id": "w2"}'
    assert kwargs["files"]["snapshot"][1] == b"TAR"


def test_load_with_a_key_takes_only_a_config(fake, tmp_path):
    config = tmp_path / "c.yaml"
    config.write_text("mounts:\n  /ram:\n    vfs: ram\n")
    result = _invoke("load", "--key", "a.tar", str(config))
    assert result.exit_code == 0, result.output
    body = fake.calls[0][2]["json"]
    assert body["key"] == "a.tar"
    assert body["override"]["mounts"]["/ram"]["vfs"] == "ram"
    assert _invoke("load", "--key", "a.tar", str(config), "x").exit_code == 2
