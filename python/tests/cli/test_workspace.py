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
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from click import unstyle
from typer.testing import CliRunner

from mirage.cli import workspace as workspace_cli
from mirage.cli.workspace import (
    _format_jobs,
    _format_logs,
    _format_processes,
    _format_workspace_explanation,
    _format_workspace_list,
    _load_config_argument,
)

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
    "resolve", [workspace_cli.resolve_config, _load_config_argument]
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
    resolved = _load_config_argument(path)
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


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "mapping"),
        ("null\n", "mapping"),
        ("false\n", "mapping"),
        ("0\n", "mapping"),
        ("[]\n", "mapping"),
        ("commands: [\n", "invalid profile YAML/JSON"),
    ],
)
def test_set_profile_refuses_a_file_that_is_not_a_mapping(
    fake, tmp_path, text, message
):
    path = tmp_path / "profile.yaml"
    path.write_text(text)
    result = _invoke("set-profile", "w", "reader", str(path))
    assert result.exit_code == 2
    assert message in result.output
    assert fake.calls == []


def test_an_explained_create_reads_as_its_verdict_and_answers():
    said = {
        "outcome": "deny",
        "reason": "no disk mounts",
        "answers": [
            {"kind": "deny", "reason": "no disk mounts", "policy": "NoDisk"}
        ],
    }
    assert _format_workspace_explanation(said) == (
        "[deny: no disk mounts]\n  NoDisk: deny: no disk mounts"
    )
    allowed = {"outcome": "allow", "reason": "", "answers": []}
    assert _format_workspace_explanation(allowed) == "[allow]"


def test_logs_queries_and_preserves_json_page(fake):
    fake.answer = _FakeResponse(200, b'{"items": [], "next": null}')
    result = _invoke(
        "logs", "-w", "w", "-s", "s1", "--limit", "2", "--after", "cursor"
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == {"items": [], "next": None}
    assert fake.calls[0] == (
        "GET",
        "/v1/workspaces/w/logs",
        {"params": {"session": "s1", "limit": "2", "after": "cursor"}},
    )


def test_logs_help_and_removed_options():
    result = _invoke("logs", "--help")
    assert result.exit_code == 0
    for flag in ("--session", "--limit", "--after", "--jsonl"):
        assert flag in unstyle(result.output)
    for flag in ("--since", "--last", "--vfs"):
        assert _invoke("logs", "-w", "w", flag, "1").exit_code != 0
    assert _invoke("history", "w").exit_code != 0


def test_logs_terminal_rows_and_cursor():
    table = _format_logs(
        {
            "items": [
                {
                    "started_at": 1000,
                    "exit_code": 0,
                    "command": "echo hi\necho bye",
                }
            ],
            "next": "cursor",
        }
    )
    assert table.splitlines()[1].split() == [
        "1970-01-01",
        "00:00:01",
        "0",
        "echo",
        "hi\\necho",
        "bye",
    ]
    assert table.splitlines()[-1] == "Next page: --after cursor"
    assert _format_logs({"items": [], "next": None}) == "No logs."


def test_logs_jsonl_streams_without_json_wrapping(fake, monkeypatch):
    @contextmanager
    def stream(method, path, **kwargs):
        fake.calls.append((method, path, kwargs))
        yield httpx.Response(200, content=b'{"command":"echo hi"}\n')

    monkeypatch.setattr(fake, "stream", stream, raising=False)
    result = _invoke("logs", "-w", "w", "--jsonl", "--session", "s1")
    assert result.exit_code == 0, result.exception
    assert result.output == '{"command":"echo hi"}\n'
    assert fake.calls[0][2]["params"]["format"] == "jsonl"


def test_create_from_a_template_sends_its_name_and_the_id(fake):
    result = _invoke("create", "--template", "base", "-w", "my-ws")
    assert result.exit_code == 0, result.output
    method, path, kwargs = fake.calls[0]
    assert (method, path) == ("POST", "/v1/workspaces")
    assert kwargs["json"] == {"template": "base", "id": "my-ws"}


@pytest.mark.parametrize("given", [[], ["CONFIG", "--template", "base"]])
def test_create_takes_one_of_a_file_or_a_template(fake, tmp_path, given):
    config = tmp_path / "c.yaml"
    config.write_text("mounts: {/: {vfs: ram}}\n")
    args = [str(config) if a == "CONFIG" else a for a in given]
    result = _invoke("create", *args)
    assert result.exit_code == 2
    assert "--template" in result.output
    assert fake.calls == []


def test_create_still_takes_id(fake, tmp_path):
    config = tmp_path / "c.yaml"
    config.write_text("mounts: {/: {vfs: ram}}\n")
    result = _invoke("create", str(config), "--id", "w2")
    assert result.exit_code == 0, result.output
    assert fake.calls[0][2]["json"]["id"] == "w2"


def test_create_sends_a_policy_name_as_written(fake, tmp_path):
    config = tmp_path / "c.yaml"
    config.write_text(
        "mounts: {/: {vfs: ram}}\n"
        "profiles:\n  reviewer:\n    policy:\n      pre_command:\n"
        "        - script: guard.py\n        - script: ./local.py\n"
    )
    result = _invoke("create", str(config))
    assert result.exit_code == 0, result.output
    reviewer = fake.calls[0][2]["json"]["config"]["profiles"]["reviewer"]
    assert reviewer["policy"]["pre_command"] == [
        {"script": "guard.py"},
        {"script": str(tmp_path.resolve() / "local.py")},
    ]


@pytest.mark.parametrize("verb", ["stop", "start"])
def test_stop_and_start_post_to_the_workspace(fake, verb):
    fake.answer = _FakeResponse(200, b'{"id": "w", "closed_at": 0}')
    result = _invoke(verb, "w")
    assert result.exit_code == 0, result.output
    assert fake.calls[0][:2] == ("POST", f"/v1/workspaces/w/{verb}")


def test_delete_names_the_workspace_when_the_answer_has_no_body(fake):
    # The console answers a delete with 204 and no body.
    fake.answer = _FakeResponse(204, b"")
    result = _invoke("delete", "my-ws")
    assert result.exit_code == 0, result.output
    assert fake.calls[0][:2] == ("DELETE", "/v1/workspaces/my-ws")
    assert json.loads(result.output) == {"id": "my-ws"}


def test_the_list_shows_each_workspace_status():
    rows = unstyle(
        _format_workspace_list(
            [
                {
                    "id": "on",
                    "status": "running",
                    "created_at": 0,
                },
                {
                    "id": "off",
                    "status": "stopped",
                    "created_at": 0,
                },
            ]
        )
    ).splitlines()
    assert [row.split() for row in rows] == [
        ["ID", "STATUS"],
        ["on", "running"],
        ["off", "stopped"],
    ]


@pytest.mark.parametrize("gone", ["close", "cancel", "kill"])
def test_close_cancel_and_kill_are_not_workspace_commands(fake, gone):
    assert _invoke(gone, "w").exit_code == 2
    assert fake.calls == []


# Each record list asks its route for the filters its options name, and
# leaves out the ones not given.
@pytest.mark.parametrize(
    ("args", "path", "params"),
    [
        (
            ("list-lines", "-w", "w", "--state", "running"),
            "/v1/workspaces/w/lines",
            {"state": "running"},
        ),
        (
            ("list-jobs", "-w", "w", "-s", "s1"),
            "/v1/workspaces/w/jobs",
            {"session_id": "s1"},
        ),
        (
            ("list-jobs", "--workspace", "w", "--line", "line_1"),
            "/v1/workspaces/w/jobs",
            {"line_id": "line_1"},
        ),
        (
            (
                "list-processes",
                "-w",
                "w",
                "--line",
                "line_1",
                "--state",
                "exited",
            ),
            "/v1/workspaces/w/processes",
            {"state": "exited", "line_id": "line_1"},
        ),
        (
            (
                "list-processes",
                "-w",
                "w",
                "--session",
                "s1",
                "--job",
                "j1",
                "--machine",
                "docker:t",
            ),
            "/v1/workspaces/w/processes",
            {"session_id": "s1", "job_id": "j1", "machine": "docker:t"},
        ),
        (("list-machines", "-w", "w"), "/v1/workspaces/w/machines", {}),
    ],
)
def test_a_record_list_asks_for_what_its_options_name(
    fake, args, path, params
):
    fake.answer = _FakeResponse(200, b"[]")
    result = _invoke(*args)
    assert result.exit_code == 0, result.output
    method, called, kwargs = fake.calls[0]
    assert (method, called, kwargs["params"]) == ("GET", path, params)


@pytest.mark.parametrize(
    "verb", ["list-lines", "list-jobs", "list-processes", "list-machines"]
)
def test_a_record_list_reads_the_current_workspace(fake, monkeypatch, verb):
    monkeypatch.setenv("MIRAGE_WORKSPACE", "cur")
    fake.answer = _FakeResponse(200, b"[]")
    result = _invoke(verb)
    assert result.exit_code == 0, result.output
    assert fake.calls[0][1].startswith("/v1/workspaces/cur/")


@pytest.mark.parametrize(
    "verb", ["list-lines", "list-jobs", "list-processes", "list-machines"]
)
def test_a_record_list_takes_no_workspace_operand(fake, home, verb):
    assert _invoke(verb, "w").exit_code == 2
    assert _invoke(verb).exit_code == 2
    assert fake.calls == []


def test_processes_read_as_one_row_per_process():
    lines = _format_processes(
        [
            {
                "pid": 2,
                "parent": None,
                "machine": "host:box",
                "session_id": "s1",
                "state": "running",
                "exit": None,
                "command": "sleep 30",
            },
            {
                "pid": 3,
                "parent": 2,
                "machine": "docker:tools",
                "session_id": "s1",
                "state": "exited",
                "exit": 143,
                "command": "cat",
            },
        ]
    ).splitlines()
    assert [line.split() for line in lines] == [
        ["PID", "PPID", "MACHINE", "SESSION", "STATE", "EXIT", "COMMAND"],
        ["2", "0", "host:box", "s1", "running", "-", "sleep", "30"],
        ["3", "2", "docker:tools", "s1", "exited", "143", "cat"],
    ]
    assert _format_processes([]) == "No processes."


def test_jobs_read_with_the_pid_each_runs_as():
    lines = _format_jobs(
        [
            {
                "id": "j1",
                "number": 1,
                "pid": 7,
                "session_id": "s1",
                "state": "running",
                "exit": None,
                "command": "sleep 30",
            },
            {
                "id": "j2",
                "number": 2,
                "pid": None,
                "session_id": "s1",
                "state": "exited",
                "exit": 0,
                "command": "true",
            },
        ]
    ).splitlines()
    assert [line.split() for line in lines] == [
        ["ID", "JOB", "PID", "SESSION", "STATE", "EXIT", "COMMAND"],
        ["j1", "%1", "7", "s1", "running", "-", "sleep", "30"],
        ["j2", "%2", "-", "s1", "exited", "0", "true"],
    ]
