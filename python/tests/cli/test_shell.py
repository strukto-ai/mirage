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
import signal
from types import SimpleNamespace
from typing import Any

from httpx._utils import peek_filelike_length
from typer.testing import CliRunner

from mirage.cli import shell


def test_piped_stdin_is_sent_without_a_size(monkeypatch):
    read, write = os.pipe()
    os.write(write, b"only what is buffered so far")
    with os.fdopen(read, "rb") as pipe:
        monkeypatch.setattr(
            shell.sys, "stdin", type("Stdin", (), {"buffer": pipe})()
        )
        part = shell._upload({"command": "cat"})["stdin"][1]
        assert peek_filelike_length(part) is None
        assert part.read(4) == b"only"
    os.close(write)


class _Answer:
    def __init__(self, status_code: int, body: dict[str, Any]) -> None:
        self.status_code = status_code
        self.content = json.dumps(body).encode()

    def json(self) -> Any:
        return json.loads(self.content)


class _InterruptedSubmit:
    """A server double that takes Ctrl-C while the line is submitted."""

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
        if path.endswith("/shell"):
            os.kill(os.getpid(), signal.SIGINT)
            return _Answer(202, {"job_id": "j1"})
        if method == "DELETE":
            return _Answer(200, {})
        return _Answer(200, {"finished_at": 1.0, "status": "canceled"})


def test_ctrl_c_during_the_submit_cancels_the_job(monkeypatch):
    client = _InterruptedSubmit()
    monkeypatch.setattr(shell, "make_client", lambda: client)
    tty = SimpleNamespace(isatty=lambda: True)
    monkeypatch.setattr(shell, "sys", SimpleNamespace(stdin=tty))
    result = CliRunner().invoke(shell.app, ["-w", "w", "-c", "sleep 20"])
    assert result.exit_code == 130
    assert ("DELETE", "/v1/jobs/j1") in client.calls


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
