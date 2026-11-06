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


import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from mirage.cli import connections
from mirage.cli.main import app
from mirage.resources.base import ResourceStore
from mirage.resources.memory import memory_resource_store
from mirage.server import build_app
from mirage.server.auth.config import AuthConfig


class Daemon:
    """The CLI's client, answered by a real app over a memory store."""

    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.calls: list[tuple[str, str, Any]] = []

    def __enter__(self) -> "Daemon":
        return self

    def __exit__(self, *_: Any) -> bool:
        return False

    def ensure_running(self, allow_spawn: bool = True) -> None:
        return None

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        self.calls.append((method, path, kwargs.get("json")))
        return self.client.request(method, path, **kwargs)


@pytest.fixture
def store() -> ResourceStore:
    return memory_resource_store()


@pytest.fixture
def daemon(monkeypatch, store) -> Daemon:
    built = build_app(
        idle_grace_seconds=10.0,
        resource_store=store,
        auth_config=AuthConfig(mode="local", local_token="t"),
    )
    double = Daemon(
        TestClient(
            built,
            base_url="http://localhost",
            headers={"Authorization": "Bearer t"},
        )
    )
    monkeypatch.setattr(connections, "make_client", lambda: double)
    return double


def run(*args: str, stdin: str | None = None) -> Any:
    return CliRunner().invoke(app, list(args), input=stdin)


def sealed(store: ResourceStore, kind: str, name: str) -> dict[str, Any]:
    return asyncio.run(store.reveal_entry(kind, name)).sealed  # type: ignore[arg-type]


def test_create_reads_a_secret_from_stdin_never_argv(daemon, store):
    r = run(
        "vfs",
        "create",
        "github",
        "--type",
        "github",
        "--set",
        "owner=strukto-ai",
        "--secret",
        "token",
        stdin="ghp_x\n",
    )
    assert r.exit_code == 0, r.output
    assert sealed(store, "vfs", "github") == {"token": "ghp_x"}
    body = daemon.calls[-1][2]
    assert body == {
        "name": "github",
        "type": "github",
        "fields": {"owner": "strukto-ai", "token": "ghp_x"},
    }
    r = run("vfs", "create", "x", "--type", "github", "--secret", "token=v")
    assert r.exit_code == 2
    assert "never comes from the command line" in r.output
    r = run("vfs", "create", "x", "--type", "github", "--set", "token=v")
    assert r.exit_code == 2
    assert "never comes from the command line" in r.output


def test_a_secret_file_loses_one_trailing_newline(daemon, store, tmp_path):
    key = tmp_path / "token"
    key.write_text("ghp_file\n")
    r = run(
        "vfs", "create", "gh", "--type", "github", "--secret", f"token=@{key}"
    )
    assert r.exit_code == 0, r.output
    assert sealed(store, "vfs", "gh") == {"token": "ghp_file"}


def test_missing_required_fields_are_named_without_a_terminal(daemon):
    r = run("cli", "create", "m", "--type", "mcp", stdin="")
    assert r.exit_code == 2
    assert "missing required fields: url" in r.output
    r = run("vfs", "create", "g", "--type", "github", "--set", "owner=o")
    assert r.exit_code == 2
    assert "missing required fields: token" in r.output


def test_set_parses_json_values(daemon, store):
    r = run(
        "vfs",
        "create",
        "gh",
        "--type",
        "github",
        "--set",
        "timeout=1",
        "--secret",
        "token",
        stdin="t\n",
    )
    assert r.exit_code == 2
    assert "timeout must be a number" in r.output
    pointer = {"from": "aws", "ref": "gh", "key": "token"}
    r = run(
        "vfs",
        "create",
        "gh",
        "--type",
        "github",
        "--set",
        f"token={json.dumps(pointer)}",
    )
    assert "add aws under Secret stores first" in r.output


def test_update_keeps_fields_and_unset_removes_them(daemon, store):
    run(
        "vfs",
        "create",
        "gh",
        "--type",
        "github",
        "--set",
        "owner=o",
        "--set",
        "repo=r",
        "--secret",
        "token",
        stdin="t1\n",
    )
    r = run("vfs", "update", "gh", "--secret", "token", stdin="t2\n")
    assert r.exit_code == 0, r.output
    got = json.loads(run("vfs", "get", "gh", "-o", "json").output)
    assert got["config"] == {"owner": "o", "repo": "r"}
    assert got["sealed"] == ["token"]
    assert sealed(store, "vfs", "gh") == {"token": "t2"}
    r = run("vfs", "update", "gh", "--unset", "repo")
    assert r.exit_code == 0, r.output
    got = json.loads(run("vfs", "get", "gh", "-o", "json").output)
    assert got["config"] == {"owner": "o"}
    r = run("vfs", "update", "gh", "--unset", "token")
    assert r.exit_code == 2
    assert "token is required" in r.output


def test_a_file_names_the_secrets_to_read(daemon, store, tmp_path: Path):
    entry = tmp_path / "gh.yaml"
    entry.write_text(
        yaml.safe_dump(
            {
                "name": "gh",
                "type": "github",
                "fields": {"owner": "o"},
                "secrets": ["token"],
            }
        )
    )
    r = run("vfs", "create", "-f", str(entry), stdin="t\n")
    assert r.exit_code == 0, r.output
    assert sealed(store, "vfs", "gh") == {"token": "t"}
    out = yaml.safe_load(run("vfs", "get", "gh", "-o", "yaml").output)
    assert out["config"] == {"owner": "o"}
    listed = json.loads(run("vfs", "list", "-o", "json").output)
    assert [i["name"] for i in listed["items"]] == ["gh"]


def test_an_export_reads_back_and_a_file_update_keeps_the_rest(
    daemon, store, tmp_path: Path
):
    run(
        "vfs",
        "create",
        "gh",
        "--type",
        "github",
        "--set",
        "owner=o",
        "--set",
        "repo=r",
        "--secret",
        "token",
        stdin="t1\n",
    )
    exported = tmp_path / "gh.yaml"
    exported.write_text(run("vfs", "get", "gh", "-o", "yaml").output)
    r = run("vfs", "create", "copy", "-f", str(exported), stdin="t2\n")
    assert r.exit_code == 0, r.output
    assert sealed(store, "vfs", "copy") == {"token": "t2"}
    change = tmp_path / "change.yaml"
    change.write_text(yaml.safe_dump({"fields": {"repo": "r2"}}))
    r = run("vfs", "update", "gh", "-f", str(change))
    assert r.exit_code == 0, r.output
    got = json.loads(run("vfs", "get", "gh", "-o", "json").output)
    assert got["config"] == {"owner": "o", "repo": "r2"}
    assert sealed(store, "vfs", "gh") == {"token": "t1"}


def test_types_and_delete(daemon, store):
    r = run("vfs", "types", "github", "-o", "json")
    assert r.exit_code == 0, r.output
    token = {f["name"]: f for f in json.loads(r.output)}["token"]
    assert token["secret"] is True
    assert run("vfs", "types", "nope").exit_code == 2
    run(
        "vfs",
        "create",
        "gh",
        "--type",
        "github",
        "--secret",
        "token",
        stdin="t\n",
    )
    r = run("vfs", "delete", "gh")
    assert r.exit_code == 0, r.output
    assert "Deleted VFS gh." in r.output
    r = run("vfs", "get", "gh")
    assert r.exit_code == 2
    assert "VFS not found" in r.output
