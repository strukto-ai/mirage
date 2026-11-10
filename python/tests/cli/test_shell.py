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
import os
from types import SimpleNamespace
from typing import Any

import pytest
from typer.testing import CliRunner

from mirage.cli import shell, stream


class _Answer:
    def __init__(self, status_code: int, body: dict[str, Any]) -> None:
        self.status_code = status_code
        self.content = json.dumps(body).encode()

    def json(self) -> Any:
        return json.loads(self.content)


class _Client:
    """A daemon double for shell CLI dispatch."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def ensure_running(self, allow_spawn: bool = True) -> None:
        return None

    def request(self, method: str, path: str, **kwargs: Any) -> _Answer:
        self.calls.append((method, path))
        return _Answer(200, {})


@pytest.mark.parametrize("json_output", [False, True])
@pytest.mark.parametrize("piped", [False, True])
def test_foreground_always_uses_the_stream_transport(
    monkeypatch, json_output, piped
):
    client = _Client()
    calls = []
    read_end, write_end = os.pipe()
    monkeypatch.setattr(shell, "make_client", lambda: client)
    monkeypatch.setattr(
        shell,
        "sys",
        SimpleNamespace(
            stdin=SimpleNamespace(
                isatty=lambda: not piped, fileno=lambda: read_end
            )
        ),
    )

    async def run(client_arg, path, payload, piped_arg, *, json_output):
        calls.append((client_arg, path, payload, piped_arg, json_output))
        return 7

    monkeypatch.setattr(stream, "stream_shell", run)
    args = ["-w", "space id", "-c", "cat", "-s", "session id"]
    result = CliRunner().invoke(
        shell.app, args + (["--json"] if json_output else [])
    )
    assert result.exit_code == 7
    assert calls == [
        (
            client,
            "/v1/workspaces/space%20id/shell?session_id=session+id&stream=true",
            {"command": "cat"},
            piped,
            json_output,
        )
    ]
    assert not client.calls
    os.close(read_end)
    os.close(write_end)


def test_an_empty_file_or_the_null_device_is_no_input(tmp_path):
    empty = tmp_path / "empty"
    empty.write_bytes(b"")
    full = tmp_path / "full"
    full.write_bytes(b"x")
    with open(empty, "rb") as a, open(full, "rb") as b, open(os.devnull) as c:
        assert not shell._has_input(a.fileno())
        assert shell._has_input(b.fileno())
        assert not shell._has_input(c.fileno())
    read_end, write_end = os.pipe()
    assert shell._has_input(read_end)
    os.close(read_end)
    os.close(write_end)


def test_a_line_may_name_its_machine(monkeypatch):
    calls = []

    async def run(client, path, payload, piped, *, json_output):
        calls.append(payload)
        return 0

    monkeypatch.setattr(shell, "make_client", _Client)
    monkeypatch.setattr(
        shell,
        "sys",
        SimpleNamespace(stdin=SimpleNamespace(isatty=lambda: True)),
    )
    monkeypatch.setattr(stream, "stream_shell", run)
    args = ["-w", "w", "-c", "train", "--machine", "gpu"]
    assert CliRunner().invoke(shell.app, args).exit_code == 0
    assert calls == [{"command": "train", "machine": "gpu"}]


@pytest.mark.parametrize(
    ("flags", "body"),
    [
        ([], {"command": "env"}),
        (["--no-record"], {"command": "env", "record": False}),
    ],
)
def test_no_record_keeps_the_line_out_of_history(monkeypatch, flags, body):
    calls = []

    async def run(client, path, payload, piped, *, json_output):
        calls.append(payload)
        return 0

    monkeypatch.setattr(shell, "make_client", _Client)
    monkeypatch.setattr(
        shell,
        "sys",
        SimpleNamespace(stdin=SimpleNamespace(isatty=lambda: True)),
    )
    monkeypatch.setattr(stream, "stream_shell", run)
    args = ["-w", "w", "-c", "env", *flags]
    assert CliRunner().invoke(shell.app, args).exit_code == 0
    assert calls == [body]


@pytest.mark.parametrize("flag", ["--workspace_id", "--session_id"])
def test_the_snake_case_spellings_are_usage_errors(flag):
    result = CliRunner().invoke(shell.app, ["-c", "true", flag, "x"])
    assert result.exit_code == 2
    assert "No such option" in result.stderr


def _command(
    text: str, outcome: str, reason: str = "", exit_code: int = 0
) -> dict[str, Any]:
    return {
        "type": "command",
        "text": text,
        "outcome": outcome,
        "exit_code": exit_code,
        "reason": reason,
        "source": "top" if reason else "",
        "runtime": "",
        "children": [],
    }


def test_explain_prints_the_line_as_its_tree():
    cat = _command("cat /data/keys/a", "deny", "sealed", 1)
    echo = _command("echo $(cat /data/keys/a)", "allow")
    echo["children"] = [
        {"type": "substitution", "text": "cat /data/keys/a", "children": [cat]}
    ]
    said = {
        "line": "ls | wc -l && echo $(cat /data/keys/a)",
        "outcome": "deny",
        "reason": "sealed",
        "answers": [],
        "exit_code": 1,
        "node": {
            "type": "line",
            "text": "ls | wc -l && echo $(cat /data/keys/a)",
            "children": [
                {
                    "type": "list",
                    "text": "ls | wc -l && echo $(cat /data/keys/a)",
                    "children": [
                        {
                            "type": "pipeline",
                            "text": "ls | wc -l",
                            "children": [
                                _command("ls", "allow"),
                                _command("wc -l", "allow"),
                            ],
                        },
                        echo,
                    ],
                }
            ],
        },
    }
    assert shell._format_explanation(said).splitlines() == [
        "ls | wc -l && echo $(cat /data/keys/a)  [deny, exit 1: sealed]",
        "  list: ls | wc -l && echo $(cat /data/keys/a)",
        "    pipeline: ls | wc -l",
        "      ls  [allow]",
        "      wc -l  [allow]",
        "    echo $(cat /data/keys/a)  [allow]",
        "      substitution: cat /data/keys/a",
        "        cat /data/keys/a  [deny, exit 1: sealed]  top",
    ]


def test_explain_prints_why_a_route_places_the_line():
    python3 = _command("python3 -c 'import sqlite3'", "allow")
    python3["runtime"] = "local"
    said = {
        "line": "python3 -c 'import sqlite3'",
        "outcome": "allow",
        "reason": "",
        "answers": [
            {
                "kind": "route",
                "runtime": "local",
                "reason": "monty has no sqlite3",
                "policy": "RoutePolicy",
            }
        ],
        "exit_code": 0,
        "node": {
            "type": "line",
            "text": "python3 -c 'import sqlite3'",
            "children": [python3],
        },
    }
    assert shell._format_explanation(said).splitlines() == [
        "python3 -c 'import sqlite3'  [allow, exit 0]",
        "  on local: monty has no sqlite3",
        "  python3 -c 'import sqlite3'  [allow]  on local",
    ]


def test_stream_broken_pipe_exits_141_without_traceback(monkeypatch):
    client = _Client()
    monkeypatch.setattr(shell, "make_client", lambda: client)
    monkeypatch.setattr(
        shell,
        "sys",
        SimpleNamespace(stdin=SimpleNamespace(isatty=lambda: True)),
    )
    error = BrokenPipeError("broken pipe")

    async def run(*args, **kwargs):
        raise error

    monkeypatch.setattr(stream, "stream_shell", run)
    result = CliRunner().invoke(shell.app, ["-w", "w", "-c", "cat"])
    assert result.exit_code == 141
    assert result.output == ""
