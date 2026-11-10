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
from contextlib import nullcontext
from typing import Any

import httpx
import pytest
from typer.testing import CliRunner

from mirage.cli import api
from mirage.cli.main import app

TAR = b"\x00\xffTAR\x80"
NDJSON = b'{"stream": "stdout", "data": "aGkK"}\n{"status": "done"}\n'
VALIDATION_DETAIL = [
    {
        "type": "missing",
        "loc": ["body", "config", "mounts"],
        "msg": "Field required",
    }
]


class _Client:
    """A server double: a 204 for a DELETE, a 404 under /missing, a tar
    under /snapshot, NDJSON under /stream, and every other request
    answered with what it got."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ensure_running(self, allow_spawn: bool = True) -> None:
        return None

    def stream(self, method: str, path: str, **kwargs: Any):
        self.calls.append(
            {"method": method, "path": path, "json": kwargs.get("json")}
        )
        if method == "DELETE":
            answer = httpx.Response(204)
        elif path.startswith("/missing"):
            answer = httpx.Response(404, json={"detail": "not found"})
        elif path.startswith("/invalid"):
            answer = httpx.Response(422, json={"detail": VALIDATION_DETAIL})
        elif path.endswith("/snapshot"):
            answer = httpx.Response(
                200, content=TAR, headers={"content-type": "application/x-tar"}
            )
        elif path.endswith("/stream"):
            answer = httpx.Response(
                200,
                content=NDJSON,
                headers={"content-type": "application/x-ndjson"},
            )
        else:
            answer = httpx.Response(200, json={"method": method, "path": path})
        return nullcontext(answer)


@pytest.fixture
def client(monkeypatch) -> _Client:
    fake = _Client()
    monkeypatch.setattr(api, "make_client", lambda: fake)
    return fake


def _run(*args: str):
    return CliRunner().invoke(app, ["api", *args])


def test_long_options_post_a_json_body(client, tmp_path):
    source = tmp_path / "guard.py"
    source.write_text("def pre_command(ctx):\n    return None\n")
    r = _run(
        "/v1/policies",
        "--name",
        "guard.py",
        f"--source=@{source}",
        "--fields",
        '{"token": "ghp_1", "port": 22}',
        "--tags",
        '["a"]',
        "--note=a=b",
        "--live",
        "--empty=",
    )
    assert r.exit_code == 0, r.output
    assert client.calls == [
        {
            "method": "POST",
            "path": "/v1/policies",
            "json": {
                "name": "guard.py",
                "source": "def pre_command(ctx):\n    return None\n",
                "fields": {"token": "ghp_1", "port": 22},
                "tags": ["a"],
                "note": "a=b",
                "live": True,
                "empty": "",
            },
        }
    ]
    assert json.loads(r.output) == {"method": "POST", "path": "/v1/policies"}


def test_a_yaml_file_is_the_body_and_a_get_has_none(client, tmp_path):
    body = tmp_path / "template.yaml"
    body.write_text("name: t\nconfig:\n  mounts:\n    /data: {vfs: ram}\n")
    assert _run("v1/templates", "--input", str(body)).exit_code == 0
    assert client.calls[0]["json"] == {
        "name": "t",
        "config": {"mounts": {"/data": {"vfs": "ram"}}},
    }
    assert _run("/v1/workspaces").exit_code == 0
    assert client.calls[1] == {
        "method": "GET",
        "path": "/v1/workspaces",
        "json": None,
    }


def test_a_files_byte_order_mark_stays(client, tmp_path):
    marked = tmp_path / "marked.txt"
    marked.write_bytes(b"\xef\xbb\xbfhi")
    assert _run("/v1/x", "--source", f"@{marked}").exit_code == 0
    assert client.calls[0]["json"] == {"source": "\ufeffhi"}


def test_yaml_keeps_timestamps_as_text(client, tmp_path):
    body = tmp_path / "workspace.yaml"
    body.write_text("config:\n  system_time: 2026-03-02T09:00:00Z\n")
    assert _run("/v1/workspaces", "--input", str(body)).exit_code == 0
    assert client.calls[0]["json"] == {
        "config": {"system_time": "2026-03-02T09:00:00Z"}
    }


def test_a_get_puts_its_fields_in_the_query_and_a_204_prints_nothing(client):
    r = _run("/v1/vfs", "--q", "gh", "-X", "get", "--type=github", "--live")
    assert r.exit_code == 0
    assert client.calls[0] == {
        "method": "GET",
        "path": "/v1/vfs?q=gh&type=github&live=true",
        "json": None,
    }
    kept = _run("/v1/workspaces/w/logs?session=s1", "--limit=1", "-X", "GET")
    assert kept.exit_code == 0
    assert client.calls[1]["path"] == (
        "/v1/workspaces/w/logs?session=s1&limit=1"
    )
    gone = _run("/v1/vfs/gh", "-X", "DELETE")
    assert (gone.exit_code, gone.output) == (0, "")


@pytest.mark.parametrize(
    "args",
    [
        ["https://elsewhere.example/v1/x"],
        ["--name", "x", "/v1/x"],
        ["/v1/x", "stray"],
        ["/v1/x", "-n", "x"],
        ["/v1/x", "--=x"],
        ["/v1/x", "--fields", "{token: 1}"],
        ["/v1/x", "--a", "1", "--input", "body.json"],
        ["/v1/x", "-X", "GET", "--input", "body.json"],
        ["/v1/x", "--source", "@latin1.txt"],
        ["/v1/x", "--input", "latin1.txt"],
    ],
)
def test_a_bad_call_exits_two_before_sending(
    client, args, tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "body.json").write_text("{}")
    (tmp_path / "latin1.txt").write_bytes(b"caf\xe9")
    r = _run(*args)
    assert r.exit_code == 2
    assert r.exception is None or isinstance(r.exception, SystemExit)
    assert client.calls == []


def test_other_answers_print_byte_for_byte(client):
    tar = _run("/v1/workspaces/w/snapshot")
    assert (tar.exit_code, tar.stdout_bytes) == (0, TAR)
    lines = _run("/v1/workspaces/w/shell/stream", "--command", "echo hi")
    assert (lines.exit_code, lines.stdout_bytes) == (0, NDJSON)


def test_an_error_answer_exits_two_with_its_detail(client):
    r = _run("/missing")
    assert r.exit_code == 2
    assert "404: not found" in r.output


def test_a_validation_answer_exits_two_with_structured_detail(client):
    r = _run("/invalid")
    assert r.exit_code == 2
    assert json.loads(r.output.split("error 422: ", 1)[1]) == VALIDATION_DETAIL
