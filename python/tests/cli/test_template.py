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
from typing import Any

import pytest
import yaml
from typer.testing import CliRunner

from mirage.cli import template as template_cli
from mirage.utils.yaml import parse_yaml

SAVED = {
    "name": "ram-only",
    "description": "a RAM disk",
    "config": {"mounts": {"/": {"vfs": "ram", "mode": "write"}}},
}


class _Response:
    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self.content = json.dumps(body).encode()

    def json(self) -> Any:
        return json.loads(self.content)


class _Client:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ensure_running(self, allow_spawn: bool = True) -> None:
        return None

    def request(self, method: str, path: str, **kwargs: Any) -> _Response:
        self.calls.append((method, path, kwargs.get("json")))
        if path == "/v1/templates" and method == "GET":
            return _Response(200, [SAVED])
        return _Response(201 if method == "POST" else 200, SAVED)


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    fake = _Client()
    monkeypatch.setattr(template_cli, "make_client", lambda: fake)
    return fake


def _invoke(*args: str):
    return CliRunner().invoke(template_cli.app, list(args))


def test_create_saves_a_bare_workspace_config(client, tmp_path):
    path = tmp_path / "ws.yaml"
    path.write_text("mounts:\n  /:\n    vfs: ram\n    mode: write\n")
    done = _invoke("create", "ram-only", "-f", str(path), "--description", "d")
    assert done.exit_code == 0, done.output
    assert client.calls == [
        (
            "POST",
            "/v1/templates",
            {
                "name": "ram-only",
                "description": "d",
                "config": SAVED["config"],
            },
        )
    ]


def test_get_as_yaml_is_a_file_create_reads_back(client, tmp_path):
    shown = _invoke("get", "ram-only", "-o", "yaml")
    assert yaml.safe_load(shown.stdout) == SAVED
    path = tmp_path / "t.yaml"
    path.write_text(shown.stdout)
    assert _invoke("create", "copy", "-f", str(path)).exit_code == 0
    assert client.calls[-1][2] == {**SAVED, "name": "copy"}


def test_a_config_that_names_a_config_key_among_others_is_a_config(
    client, tmp_path
):
    path = tmp_path / "ws.yaml"
    path.write_text('{"mounts": {}, "config": {"x": 1}}')
    assert _invoke("create", "t", "-f", str(path)).exit_code == 0
    assert client.calls[-1][2]["config"] == {"mounts": {}, "config": {"x": 1}}


def test_list_prints_json_or_yaml(client):
    assert json.loads(_invoke("list", "-o", "json").stdout) == [SAVED]
    assert yaml.safe_load(_invoke("list", "-o", "yaml").stdout) == [SAVED]
    assert _invoke("list", "-o", "xml").exit_code == 2


def test_delete_and_restore_name_the_template(client):
    assert _invoke("delete", "a b").exit_code == 0
    assert _invoke("restore", "a b").exit_code == 0
    assert [c[:2] for c in client.calls] == [
        ("DELETE", "/v1/templates/a%20b"),
        ("POST", "/v1/templates/a%20b/restore"),
    ]


def test_a_file_that_is_not_a_mapping_is_refused(client, tmp_path):
    path = tmp_path / "t.yaml"
    path.write_text("- a\n")
    done = _invoke("create", "t", "-f", str(path))
    assert done.exit_code == 2
    assert client.calls == []


def test_create_rebases_a_relative_script_onto_the_files_folder(
    client, tmp_path
):
    folder = tmp_path / "deploy"
    folder.mkdir()
    path = folder / "ws.yaml"
    path.write_text("clis:\n  tally:\n    script: ./tally.py\n")
    done = _invoke("create", "tally", "-f", str(path))
    assert done.exit_code == 0, done.output
    sent = client.calls[0][2]["config"]["clis"]["tally"]["script"]
    assert sent == str(folder.resolve() / "tally.py")


def test_a_description_that_is_no_string_is_refused(client, tmp_path):
    path = tmp_path / "t.yaml"
    path.write_text("description: 123\nconfig:\n  mounts: {}\n")
    done = _invoke("create", "t", "-f", str(path))
    assert done.exit_code == 2
    assert "description must be a string" in done.output
    assert client.calls == []


def test_get_yaml_keeps_ambiguous_strings_strings(client, monkeypatch):
    saved = {
        "name": "env",
        "description": None,
        "config": {"env": {"A": "1e3", "B": "off", "C": "0o17"}},
    }
    monkeypatch.setattr(
        client, "request", lambda method, path, **kw: _Response(200, saved)
    )
    done = _invoke("get", "env", "-o", "yaml")
    assert done.exit_code == 0, done.output
    assert parse_yaml(done.output)["config"] == saved["config"]

