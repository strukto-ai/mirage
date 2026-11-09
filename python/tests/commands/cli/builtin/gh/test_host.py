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

import pytest

from mirage import Workspace
from mirage.commands.cli.builtin.gh import GH
from mirage.commands.cli.builtin.gh.host import GhHost
from mirage.core.api.client import ApiResponse
from mirage.core.github.client import GitHubApiError, GitHubConnectionError
from mirage.core.github.config import GhConfig
from mirage.io.errors import MemoryExhausted
from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.policy import Deny, Policy
from mirage.types import JsonValue, MountMode
from mirage.vfs.ram import RAMVFS

HOST = "mirage.commands.cli.builtin.gh.host.github_raw_response"
PULL = {
    "number": 5,
    "title": "t",
    "state": "open",
    "base": {"ref": "main"},
    "head": {"ref": "f"},
    "user": {"login": "a"},
    "body": "b",
}


class _Github:
    def __init__(self, reply: "JsonValue | Exception" = PULL) -> None:
        self.reply = reply
        self.calls: list[tuple] = []

    async def __call__(
        self, account, method, path, body=None, params=None, *, headers=None
    ) -> ApiResponse:
        self.calls.append((method, path, body, params, headers))
        if isinstance(self.reply, Exception):
            raise self.reply
        return ApiResponse(
            json.dumps(self.reply).encode(),
            200,
            {"content-type": "application/json"},
        )


def _workspace(**kwargs) -> Workspace:
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        **kwargs,
    )
    ws.register_cli("gh", GH, GhConfig(token="t", repo="o/r"))
    return ws


async def _line(ws: Workspace, line: str, sid: str | None = None):
    result = await (
        ws.shell(line) if sid is None else ws.shell(line, session_id=sid)
    )
    return (
        result.exit_code,
        await result.stdout_str(),
        await result.stderr_str(),
    )


@pytest.mark.asyncio
async def test_a_subcommand_runs_through_the_host_call(monkeypatch):
    node = {"title": "t", "state": "OPEN", "number": 5, "isDraft": False}
    github = _Github({"data": {"repository": {"pullRequest": node}}})
    monkeypatch.setattr(HOST, github)
    ws = _workspace()
    code, out, _ = await _line(ws, "gh pr view 5")
    await ws.close()
    assert (code, out.splitlines()[0]) == (0, "title:\tt")
    assert github.calls[0][:2] == ("POST", "graphql")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "denied, line",
    [("gh pr view", "gh pr view 5"), ("gh pr list", "gh pr ls")],
)
async def test_a_denied_subcommand_never_reaches_github(
    monkeypatch, denied, line
):
    github = _Github()
    monkeypatch.setattr(HOST, github)
    ws = _workspace(profiles={"p": {"commands": {"deny": [denied]}}})
    ws.create_session("s", profile="p")
    code, _, _ = await _line(ws, line, "s")
    await ws.close()
    assert code == 126
    assert github.calls == []


class _NoSecrets(Policy):
    async def pre_vfs(self, ctx):
        return Deny("no") if "secret" in ctx.path.virtual else None


@pytest.mark.asyncio
async def test_a_body_file_is_read_under_the_sessions_file_policy(monkeypatch):
    github = _Github()
    monkeypatch.setattr(HOST, github)
    ws = _workspace(policies=[_NoSecrets()])
    await ws.shell("echo x > /data/secret.md")
    code, _, err = await _line(
        ws, "gh issue comment 1 --body-file /data/secret.md"
    )
    await ws.close()
    assert code == 1
    assert "/data/secret.md" in err
    assert github.calls == []


@pytest.mark.asyncio
async def test_a_failed_call_is_worded_after_the_subcommand(monkeypatch):
    failure = GitHubApiError(
        "Not Found",
        404,
        body='{"message": "Not Found"}',
        url="https://api.github.com/graphql",
        headers={"content-type": "application/json"},
    )
    monkeypatch.setattr(HOST, _Github(failure))
    ws = _workspace()
    code, _, err = await _line(ws, "gh pr view 5")
    await ws.close()
    assert (code, err) == (
        1,
        "HTTP 404: Not Found (https://api.github.com/graphql)\n",
    )


@pytest.mark.asyncio
async def test_a_connection_failure_is_worded_after_the_subcommand(
    monkeypatch,
):
    monkeypatch.setattr(HOST, _Github(GitHubConnectionError("no route")))
    ws = _workspace()
    code, _, err = await _line(ws, "gh pr view 5")
    await ws.close()
    assert (code, err) == (1, "no route\n")


@pytest.mark.asyncio
async def test_a_usage_error_keeps_its_own_words(monkeypatch):
    github = _Github()
    monkeypatch.setattr(HOST, github)
    ws = _workspace()
    code, _, err = await _line(ws, "gh repo delete o/r")
    await ws.close()
    assert code == 1
    assert err.startswith(
        "--yes required when not running interactively\n\n"
        "Usage:  gh repo delete [<repository>] [flags]\n"
    )
    assert github.calls == []


@pytest.mark.asyncio
async def test_output_before_a_jq_failure_stays_on_stdout(monkeypatch):
    monkeypatch.setattr(HOST, _Github({"a": 1}))
    ws = _workspace()
    code, out, err = await _line(ws, """gh api /x --jq '.a, error("no")'""")
    await ws.close()
    assert (code, out) == (1, "1\n")
    assert err == "error: no\n"


@pytest.mark.asyncio
async def test_a_warning_lands_on_stderr_and_succeeds(monkeypatch):
    issue = {"__typename": "Issue", "number": 1, "state": "OPEN", "title": "t"}
    repository = {"hasIssuesEnabled": True, "issue": issue}
    monkeypatch.setattr(HOST, _Github({"data": {"repository": repository}}))
    ws = _workspace()
    code, _, err = await _line(ws, "gh issue reopen 1")
    await ws.close()
    assert (code, err) == (0, "! Issue o/r#1 (t) is already open\n")


@pytest.mark.asyncio
async def test_a_memory_request_is_held_to_the_workspace_budget():
    host = GhHost(None, None)
    budget = MemoryBudget(10, lambda: 0)
    await run_with_memory(
        budget, host.serve({"op": "memory", "size": 10}, b"")
    )
    with pytest.raises(MemoryExhausted):
        await run_with_memory(
            budget, host.serve({"op": "memory", "size": 11}, b"")
        )
