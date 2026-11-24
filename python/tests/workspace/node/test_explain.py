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
import dataclasses
import time

import pytest
import pytest_asyncio
from pydantic import BaseModel, ConfigDict

from mirage import Session, Workspace
from mirage.context.session_context import (
    reset_caller,
    set_decision_sink,
    set_explaining,
)
from mirage.execution.ram import RAMExecutionStore
from mirage.policy import (
    Action,
    Ask,
    CommandContext,
    CommandExplanation,
    Deny,
    HandOff,
    Policies,
    Policy,
    Route,
    ShellNode,
    VfsContext,
)
from mirage.policy.match import Outcome
from mirage.policy.types import DryRun, Scope
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.table import whole_line_runtime
from mirage.runtime.types import RunResult, ScriptSource
from mirage.secrets import registry as secrets_registry
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.shell.console import ConsoleStore
from mirage.shell.parse import parse
from mirage.shell.variable import VarAttr
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace.node.explain import (
    Judgment,
    JudgmentMode,
    explain_line,
    line_judgments,
    may_prejudge,
)
from mirage.workspace.session.state import seed_var, set_attr


async def _judged(
    ws: Workspace, line: str, session_id: str = ""
) -> list[Judgment]:
    """A line's per-command judgments, read as ``Workspace.explain``
    reads them.

    Args:
        ws (Workspace): the workspace to judge the line in.
        line (str): the line to judge.
        session_id (str): whose profile to judge it under; the default
            session when empty.
    """
    await ws.ensure_sessions_loaded()
    session = ws.get_session(session_id or ws.default_session_id)
    sink_token = set_decision_sink(lambda decision: None)
    token = set_explaining(DryRun.DECIDING)
    try:
        judged = await explain_line(
            parse(line),
            session,
            ws._registry,
            ws._namespace,
            JudgmentMode.EXPLAIN_WHOLE_LINE
            if whole_line_runtime(ws._registry.runtime_bindings) is not None
            else JudgmentMode.EXPLAIN,
        )
    finally:
        reset_caller(token)
        reset_caller(sink_token)
    return [one.judgment for one in judged]


class _FakeConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


async def _dead_fetch(config: _FakeConfig, ref: str) -> ResolvedSecret:
    raise RuntimeError("connection refused")


PROFILE = {
    "commands": {
        "*": "deny",
        "ls": "allow",
        "cat": [
            "allow",
            {
                "decision": "ask",
                "reason": "secrets need sign-off",
                "paths": [
                    "/data/secret.txt",
                    "/data/secret file",
                    "/data/secr\u00e9t",
                ],
            },
        ],
        "git": {
            "*": "allow",
            "operands": {
                "push": {"decision": "ask", "reason": "pushes need sign-off"}
            },
        },
        "rm": [
            "allow",
            {
                "decision": "deny",
                "reason": "production data is protected",
                "paths": ["/data/prod/*"],
            },
        ],
        "mkdir": "allow",
        "cd": "allow",
        "echo": "allow",
        "sleep": "allow",
        "wait": "allow",
        "eval": "allow",
        "command": "allow",
        "xargs": "allow",
        "touch": "allow",
        "printf": "allow",
        "mapfile": "allow",
        "alias": "allow",
        "shopt": "allow",
    },
}

# The same world under a rule that speaks on the command name alone, so
# a spelling whose operands only the runtime can read is still asked
# about.
ASK_CAT = {
    "commands": {
        **PROFILE["commands"],
        "cat": {"decision": "ask", "reason": "reads need sign-off"},
    },
}

DENY_CAT = {
    "commands": {
        **PROFILE["commands"],
        "cat": {"decision": "deny", "reason": "reads are refused"},
    },
}


@pytest_asyncio.fixture()
async def ws():
    workspace = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles={"r": PROFILE}
    )
    await workspace.shell("mkdir -p /data/prod")
    await workspace.vfs.write("/data/prod/x.txt", b"x\n")
    await workspace.vfs.write("/data/a.txt", b"a\n")
    await workspace.vfs.write("/data/secret.txt", b"s\n")
    workspace.create_session("s", profile="r")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_explain_answers_each_verb_and_names_the_rule(ws):
    (allowed,) = await _judged(ws, "cat /data/a.txt", "s")
    assert allowed.outcome is Outcome.ALLOW
    assert allowed.exit_code == 0
    assert allowed.stderr == ""
    assert allowed.rule is None

    (denied,) = await _judged(ws, "rm /data/prod/x.txt", "s")
    assert denied.outcome is Outcome.DENY
    assert denied.rule is not None
    assert denied.reason == "production data is protected"
    assert denied.source == "top"
    assert denied.matched_path == "/data/prod/x.txt"

    (asked,) = await _judged(ws, "git push origin main", "s")
    assert asked.outcome is Outcome.ASK
    assert asked.reason == "pushes need sign-off"


@pytest.mark.asyncio
async def test_a_word_the_tree_names_nothing_for_is_a_deny_at_126(ws):
    # The root's own decision speaks for a word the tree names nothing
    # for: a DENY refused in bash's words like any other.
    (missing,) = await _judged(ws, "gerp x", "s")
    assert missing.outcome is Outcome.DENY
    assert missing.rule is not None and missing.rule.at == "/*"
    assert missing.source == "top"
    assert missing.exit_code == 126
    assert missing.stderr == "gerp: Permission denied\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["timeout 5 sort /data/a.txt", "eval sort /data/a.txt"]
)
async def test_a_word_the_tree_closes_is_refused_where_it_runs(
    line,
):
    # A builtin that runs a word hands it to the gate, which refuses it
    # there, and the dry run says what the run says.
    workspace = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={
            "r": {
                "commands": {"*": "deny", "timeout": "allow", "eval": "allow"}
            }
        },
    )
    await workspace.vfs.write("/data/a.txt", b"a\n")
    workspace.create_session("s", profile="r")
    try:
        ran = await workspace.shell(line, session_id="s")
        missing = (await _judged(workspace, line, "s"))[-1]
    finally:
        await workspace.close()
    said = "sort: Permission denied\n"
    assert (ran.exit_code, ran.stderr) == (126, said.encode())
    assert (missing.exit_code, missing.stderr) == (126, said)
    assert (missing.command, missing.source) == ("sort", "top")


@pytest.mark.asyncio
async def test_explain_reads_every_command_of_a_line(ws):
    first, second = await _judged(
        ws, "cat /data/a.txt && rm /data/prod/x.txt", "s"
    )
    assert (first.command, first.outcome) == ("cat", Outcome.ALLOW)
    assert (second.command, second.outcome) == ("rm", Outcome.DENY)


@pytest.mark.asyncio
async def test_explain_reads_a_reserved_word_alias_as_a_command(ws):
    await ws.shell(
        "shopt -s expand_aliases; alias fi='echo works'", session_id="s"
    )
    said = await ws.explain("fi", "s")
    assert [child.command for child in said.node.children] == ["fi"]


@pytest.mark.asyncio
async def test_explain_says_exactly_what_the_run_would_say(ws):
    for line in ("rm /data/prod/x.txt", "git push origin main", "gerp x"):
        ran = await ws.shell(line, session_id="s")
        (said,) = await _judged(ws, line, "s")
        assert said.exit_code == ran.exit_code
        assert said.stderr == (ran.stderr or b"").decode()


@pytest.mark.asyncio
async def test_only_a_verdict_refuses_the_whole_line(ws):
    # A word the closed root refuses fails where it stands and the
    # rest of the line runs, so the line exits as its last command does
    # while its outcome is the refusal; a rule's refusal holds the whole
    # line, whatever failed before it.
    said = await ws.explain("gerp x; echo ok", "s")
    ran = await ws.shell("gerp x; echo ok", session_id="s")
    assert (ran.exit_code, said.outcome, said.exit_code) == (
        0,
        Outcome.DENY,
        0,
    )
    assert said.stderr == await ran.stderr_str()
    gerp, _ = said.node.children
    assert isinstance(gerp, CommandExplanation)
    assert (gerp.outcome, gerp.exit_code, gerp.stderr, gerp.source) == (
        Outcome.DENY,
        126,
        "gerp: Permission denied\n",
        "top",
    )
    line = "gerp x; rm /data/prod/x.txt"
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    assert ran.decision is not None and said.decision is not None
    assert (said.exit_code, said.stderr, said.decision.reason) == (
        ran.exit_code,
        await ran.stderr_str(),
        ran.decision.reason,
    )


@pytest.mark.asyncio
async def test_explain_spends_nothing(ws):
    # A dry run of an ask must not put the question to anyone, or the
    # host would field requests for lines nobody typed, and must not
    # spend a grant, or explaining a line would use up its answer.
    for _ in range(3):
        await ws.explain("git push origin main", "s")
    assert ws.decisions.pending() == ()
    assert ws.get_session("s").decisions == ()
    await ws.explain("rm /data/prod/x.txt", "s")
    assert sorted(await ws.vfs.readdir("/data")) == [
        "/data/a.txt",
        "/data/prod",
        "/data/secret.txt",
    ]


@pytest.mark.asyncio
async def test_a_denied_command_stops_the_whole_line(ws):
    # The agent composed the line as one intent, so a rule refusing
    # part of it refuses the intent: judging each command as the
    # dispatcher reached it deleted the first file and refused the
    # second.
    ran = await ws.shell(
        "rm /data/a.txt && rm /data/prod/x.txt", session_id="s"
    )
    assert ran.exit_code == 1
    assert ran.stderr == (
        b"rm: cannot remove '/data/prod/x.txt': Permission denied\n"
    )
    assert "/data/a.txt" in await ws.vfs.readdir("/data")
    recorded = await ws.history(session_id="s")
    assert [(e["type"], e.get("exit_code")) for e in recorded] == [
        ("command", None),
        ("result", 1),
    ]


@pytest.mark.asyncio
async def test_a_word_the_allow_list_leaves_out_leaves_the_line_alone(ws):
    # The closed root refuses a word where it stands, not the line: the
    # stage fails and the rest of the line does what bash does. A typo
    # must not cost an agent the work the line already did.
    ran = await ws.shell("rm /data/a.txt && gerp x", session_id="s")
    assert ran.exit_code == 126
    assert ran.stderr == b"gerp: Permission denied\n"
    assert "/data/a.txt" not in await ws.vfs.readdir("/data")


@pytest.mark.asyncio
async def test_an_asked_command_holds_the_line_until_it_is_answered(ws):
    line = "rm /data/a.txt && cat /data/secret.txt"
    ran = await ws.shell(line, session_id="s")
    assert ran.exit_code == 126
    assert "/data/a.txt" in await ws.vfs.readdir("/data")
    # Exactly one request, from the one pass that judged the line.
    (pending,) = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
    # The whole line replays, which is only sound because none of it
    # ran the first time, and the grant is spent exactly once even
    # though two passes now read it.
    again = await ws.shell(line, session_id="s")
    assert again.exit_code == 0
    assert "/data/a.txt" not in await ws.vfs.readdir("/data")
    assert ws.decisions.pending() == ()


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["deny", "ask"])
@pytest.mark.parametrize(
    "line",
    [
        "echo before; cat /data/f.txt",
        "cat /data/f.txt; echo after",
        "f(){ cat /data/f.txt; }; f; f(){ cat /data/f.txt; }; f",
    ],
)
async def test_a_folder_entrys_star_holds_the_whole_line(decision, line):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo kept > /data/f.txt")
    ws.create_session(
        "s",
        profile={
            "commands": {"*": "allow"},
            "mounts": {"/data": {"commands": {"*": decision}}},
        },
    )
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    assert (ran.exit_code, ran.stdout) == (126, b"")
    assert ran.stderr == b"cat: Permission denied\n"
    assert (said.exit_code, said.stderr) == (126, "cat: Permission denied\n")
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["deny", "ask"])
@pytest.mark.parametrize(
    ("line", "exit_code", "stdout", "stderr"),
    [
        ("f() { ls; }; f", 0, b"f.txt\n", b""),
        (
            "f() { cat /data/f.txt; }; f",
            126,
            b"",
            b"cat: Permission denied\n",
        ),
        ("f() { ls; }; f; cat f.txt", 126, b"", b"cat: Permission denied\n"),
        (
            "echo before; f() { ls; }; f",
            126,
            b"",
            b"echo: Permission denied\n",
        ),
        ("f; f() { ls; }", 126, b"", b"f: Permission denied\n"),
        ("f() { ls; }; g() { f; }; g", 0, b"f.txt\n", b""),
        ("g() { f; }; f() { ls; }; g", 0, b"f.txt\n", b""),
        ("(f() { ls; }); f", 126, b"", b"f: Permission denied\n"),
        ("{ f() { ls; }; }; f", 126, b"", b"f: Permission denied\n"),
        ("(f() { ls; }; f)", 126, b"", b"f: Permission denied\n"),
        ("f() { ls; }; (f)", 0, b"f.txt\n", b""),
        ("  f() { ls; }; f", 0, b"f.txt\n", b""),
        ("timeout() { ls; }; timeout 1 rm f.txt", 0, b"f.txt\n", b""),
        ("f() { ls; }; MODE=test f", 0, b"f.txt\n", b""),
        ("f() { ls; }; f /data/f.txt", 0, b"f.txt\n", b""),
        ("f() { ls; }; f > /out.txt", 0, b"", b""),
    ],
)
async def test_a_function_the_line_defines_is_not_held_by_a_folders_star(
    decision, line, exit_code, stdout, stderr
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo kept > /data/f.txt")
    ws.create_session(
        "s",
        profile={
            "commands": {"*": "allow"},
            "mounts": {
                "/data": {
                    "commands": {"*": decision, "cd": "allow", "ls": "allow"}
                }
            },
        },
    )
    await ws.shell("cd /data", session_id="s")
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    assert (ran.exit_code, ran.stdout, ran.stderr or b"") == (
        exit_code,
        stdout,
        stderr,
    )
    assert (said.exit_code, said.stderr) == (exit_code, stderr.decode())
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "held_on"),
    [
        ("printf x > /marker; false && f() { ls; }; f", "f"),
        ("printf x > /marker; true && f() { ls; }; f", "f"),
        ("f() { ls; }; unset -f f; printf x > /marker; f", "f"),
        ("printf x > /marker; f() { ls; }; unset f; f", "f"),
        ("printf x > /marker; f() { ls; }; unset -v x; f", "f"),
        ("printf x > /marker; f() { ls; }; un''set -f f; f", "f"),
        ("printf x > /marker; f() { ls; }; command unset -f f; f", "f"),
        ("printf x > /marker; (f() { ls; }); f", "f"),
        ("printf x > /marker; f() { ls; } | ls; f", "f"),
        ("printf x > /marker; f() { ls; } & f", "f"),
        ("printf x > /marker; cat() { :; }; command cat a", "cat"),
        ("printf x > /marker; cat() { ls; }; timeout 1 cat f.txt", "cat"),
        ('printf x > /marker; cat() { ls; }; sh -c "cat f.txt"', "cat"),
        ("printf x > /marker; trap : ERR; f() { ls; }; f", "f"),
        ("printf x > /marker; f() { cat /data/a; }; f", "cat"),
        ("printf x > /marker; timeout 1 cat f.txt", "cat"),
        ('printf x > /marker; sh -c "cat f.txt"', "cat"),
    ],
)
async def test_a_function_the_line_may_not_have_defined_leaves_the_line_held(
    line, held_on
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo kept > /data/f.txt")
    allowed = ["cd", "ls", "printf", "false", "true", ":", "command"]
    allowed += ["unset", "trap", "timeout", "sh"]
    ws.create_session(
        "s",
        profile={
            "commands": {"*": "allow"},
            "mounts": {
                "/data": {
                    "commands": {
                        "*": "deny",
                        **dict.fromkeys(allowed, "allow"),
                    }
                }
            },
        },
    )
    await ws.shell("cd /data", session_id="s")
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    stderr = f"{held_on}: Permission denied\n"
    assert (ran.exit_code, ran.stdout, ran.stderr) == (
        126,
        b"",
        stderr.encode(),
    )
    assert (said.exit_code, said.stderr) == (126, stderr)
    marker = await ws.shell("test -e /marker")
    assert marker.exit_code == 1
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["deny", "ask"])
@pytest.mark.parametrize(
    "line",
    [
        "printf x > /marker; f() { echo hi; }; f > /data/f.txt",
        "printf x > /marker; f() { cat; }; f < /data/f.txt",
    ],
)
async def test_a_redirect_into_the_folder_holds_a_function_the_line_defines(
    decision, line
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo kept > /data/f.txt")
    ws.create_session(
        "s",
        profile={
            "commands": {"*": "allow"},
            "mounts": {"/data": {"commands": {"*": decision}}},
        },
    )
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    assert (ran.exit_code, ran.stdout, ran.stderr) == (
        126,
        b"",
        b"f: Permission denied\n",
    )
    assert (said.exit_code, said.stderr) == (126, "f: Permission denied\n")
    marker = await ws.shell("test -e /marker")
    assert marker.exit_code == 1
    kept = await ws.shell("cat /data/f.txt")
    assert kept.stdout == b"kept\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_redirect_into_another_entry_holds_a_function_the_line_defines():
    ws = Workspace(
        {"/data/": RAMVFS(), "/vault/": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.shell("echo kept > /vault/f.txt")
    ws.create_session(
        "s",
        profile={
            "commands": {"*": "allow"},
            "mounts": {
                "/data": {"commands": {"*": "deny", "cd": "allow"}},
                "/vault": {"commands": {"*": "deny"}},
            },
        },
    )
    await ws.shell("cd /data", session_id="s")
    line = "f() { echo hi; }; f > /vault/f.txt"
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    assert (ran.exit_code, ran.stderr) == (126, b"f: Permission denied\n")
    assert said.exit_code == 126
    kept = await ws.shell("cat /vault/f.txt")
    assert kept.stdout == b"kept\n"
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("cwd", "line", "exit_code", "stdout", "stderr"),
    [
        ("/", "cd /data; cd -; echo hi", 0, b"/\nhi\n", b""),
        ("/", "cd /data; D=/; cd $D; echo hi", 0, b"hi\n", b""),
        (
            "/",
            "cd /data/nope; echo hi",
            0,
            b"hi\n",
            b"bash: line 1: cd: /data/nope: No such file or directory\n",
        ),
        ("/data", "eval 'f() { ls; }'; f", 0, b"f.txt\n", b""),
        (
            "/data",
            "report() { echo hi; }; cd /; report",
            0,
            b"hi\n",
            b"",
        ),
        (
            "/data",
            "f() { cat f.txt; }; f",
            126,
            b"",
            b"cat: Permission denied\n",
        ),
    ],
)
async def test_a_folders_star_leaves_a_command_the_walk_cannot_place_to_the_gate(
    cwd, line, exit_code, stdout, stderr
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo kept > /data/f.txt")
    allowed = ["cd", "ls", "eval"]
    ws.create_session(
        "s",
        profile={
            "commands": {"*": "allow"},
            "mounts": {
                "/data": {
                    "commands": {
                        "*": "deny",
                        **dict.fromkeys(allowed, "allow"),
                    }
                }
            },
        },
    )
    await ws.shell(f"cd {cwd}", session_id="s")
    ran = await ws.shell(line, session_id="s")
    assert (ran.exit_code, ran.stdout, ran.stderr or b"") == (
        exit_code,
        stdout,
        stderr,
    )
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "printf x > /marker; cat f.txt; (cat() { :; })",
        "printf x > /marker; cat f.txt; cat() { :; }",
        "printf x > /marker; cat f.txt; v=$(cat() { :; })",
        "printf x > /marker; cat f.txt; cat() { :; } | :",
        "printf x > /marker; cat f.txt; { cat() { :; }; }",
        "f() { printf x > /marker; cat /data/f.txt; }; f; (cat() { :; })",
    ],
)
async def test_a_definition_where_the_word_cannot_see_it_leaves_the_line_held(
    line,
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo kept > /data/f.txt")
    ws.create_session(
        "s",
        profile={
            "commands": {"*": "allow"},
            "mounts": {
                "/data": {
                    "commands": {
                        "*": "deny",
                        "cd": "allow",
                        "printf": "allow",
                        ":": "allow",
                    }
                }
            },
        },
    )
    await ws.shell("cd /data", session_id="s")
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    assert (ran.exit_code, ran.stdout, ran.stderr) == (
        126,
        b"",
        b"cat: Permission denied\n",
    )
    assert (said.exit_code, said.stderr) == (126, "cat: Permission denied\n")
    marker = await ws.shell("test -e /marker")
    assert marker.exit_code == 1
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("test", "status"),
    [
        ("[[ ! -e /data/secret.txt ]]", "1"),
        ("[[ -e /data/a.txt && -e /data/secret.txt ]]", "0"),
        ("[ ! -e /data/secret.txt ]", "1"),
    ],
)
async def test_an_asked_test_runs_once_on_its_one_nod(test, status):
    # Every reader of the line reads a test by the run's own tokens and
    # grammar, a [[ ]] a leaf at a time, so the question the pass asked
    # is the one the gate answers: the line runs once, on one nod.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/data/a.txt", b"a\n")
    await ws.vfs.write("/data/secret.txt", b"s\n")
    ws.create_session(
        "s",
        profile={
            "commands": {
                "*": {
                    "decision": "ask",
                    "reason": "nod",
                    "paths": ["/data/secret.txt"],
                }
            }
        },
    )
    line = f"echo before; {test}; echo rc=$?"
    held = await ws.shell(line, session_id="s")
    assert (held.exit_code, held.stdout) == (126, b"")
    (pending,) = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
    ran = await ws.shell(line, session_id="s")
    assert ran.stdout == f"before\nrc={status}\n".encode()
    assert ws.decisions.pending() == ()
    await ws.close()


@pytest.mark.asyncio
async def test_a_question_the_gate_asks_where_it_runs_holds_no_line():
    # find -exec hands cat words the runtime completes, so the run
    # leaves cat's question to the gate where it runs and holds nothing;
    # explain says the same rather than a hold the run never makes.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/data/a.txt", b"a\n")
    await ws.vfs.write("/data/secret.txt", b"s\n")
    ws.create_session(
        "s",
        profile={
            "commands": {
                "*": {
                    "decision": "ask",
                    "reason": "nod",
                    "paths": ["/data/secret.txt"],
                }
            }
        },
    )
    line = "find /data -name a.txt -exec cat /data/secret.txt \\;"
    said = await ws.explain(line, "s")
    ran = await ws.shell(line, session_id="s")
    assert (said.exit_code, said.outcome) == (0, Outcome.ASK)
    assert (ran.exit_code, ran.stderr) == (0, b"cat: Permission denied\n")
    assert len(ws.decisions.pending()) == 1
    await ws.close()


@pytest.mark.asyncio
async def test_a_cd_earlier_in_the_line_moves_what_later_rules_read(ws):
    # The line is judged before it runs, so the pass has to walk a
    # literal `cd` itself or a rule about /data/prod would answer about
    # whatever directory the session happened to be in.
    ran = await ws.shell("cd /data/prod && rm x.txt", session_id="s")
    assert ran.exit_code == 1
    assert ran.stderr == b"rm: cannot remove 'x.txt': Permission denied\n"


@pytest.mark.asyncio
async def test_explain_reads_a_cd_the_same_way_the_run_does(ws):
    # explain and the pass that decides the line share one walk, so a
    # host asking about a line and the agent typing it cannot be told
    # different things about where the line ends up.
    line = "cd /data/prod && rm x.txt"
    _, removed = await _judged(ws, line, "s")
    assert removed.outcome is Outcome.DENY
    ran = await ws.shell(line, session_id="s")
    assert removed.exit_code == ran.exit_code
    assert removed.stderr == (ran.stderr or b"").decode()


@pytest.mark.asyncio
async def test_the_hold_reaches_only_as_far_as_the_text_does(ws):
    # The pass reads the text of a line and the gate reads its values,
    # so a path the runtime computes is invisible here and the hold
    # lapses. The ask still fires, at the gate, once the earlier
    # commands have run. Pinned rather than only documented, because
    # the cost lands on the replay: approving this re-runs a line whose
    # first half is already done.
    ran = await ws.shell(
        "S=/data/secret.txt; rm /data/a.txt && cat $S", session_id="s"
    )
    assert ran.exit_code == 126
    assert "/data/a.txt" not in await ws.vfs.readdir("/data")
    assert len(ws.decisions.pending()) == 1


@pytest.mark.asyncio
async def test_a_cd_in_a_subshell_does_not_move_later_commands(ws):
    # bash restores the cwd when the subshell exits, so carrying the cd
    # past it refused a line that was never going to touch /data/prod.
    ran = await ws.shell("(cd /data/prod && ls) && rm x.txt", session_id="s")
    assert ran.exit_code == 1
    assert b"production data is protected" not in (ran.stderr or b"")
    assert "/data/prod/x.txt" in await ws.vfs.readdir("/data/prod")


@pytest.mark.asyncio
async def test_a_grant_the_session_holds_shows_the_line_running(ws):
    ran = await ws.shell("git push origin main", session_id="s")
    assert ran.exit_code == 126
    (pending,) = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.SESSION)
    # The document still says ask, because that is what it says; the
    # exit code says 0, because that is what the line would now do.
    (asked,) = await _judged(ws, "git push origin main", "s")
    assert asked.outcome is Outcome.ASK
    assert asked.exit_code == 0
    assert asked.stderr == ""
    said = await ws.explain("git push origin main", "s")
    assert (said.outcome, said.reason, said.exit_code, said.decision) == (
        Outcome.ASK,
        "pushes need sign-off",
        0,
        None,
    )


_SEALED_PROD = {
    "decision": "deny",
    "reason": "sealed until review",
    "paths": ["/data/prod/*"],
}

SEALED = {
    "commands": {
        "*": "deny",
        **{
            name: ["allow", _SEALED_PROD]
            for name in ("ls", "cat", "rm", "mkdir", "echo")
        },
    },
}


@pytest_asyncio.fixture()
async def sealed():
    workspace = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles={"r": SEALED}
    )
    await workspace.shell("mkdir -p /data/prod")
    await workspace.vfs.write("/data/prod/x.txt", b"x\n")
    await workspace.vfs.write("/data/a.txt", b"a\n")
    workspace.create_session("s", profile="r")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_explain_reads_the_statements_redirect_target(sealed):
    # The shell opens a redirect on its own fd, outside the window the
    # command's own gate covers, so admission reads the target as a word
    # of the command. The dry run has to read it the same way or it
    # answers ALLOW for a line the run refuses.
    (said,) = await _judged(sealed, "echo x > /data/prod/x.txt", "s")
    assert said.outcome is Outcome.DENY
    assert said.reason == "sealed until review"


@pytest.mark.asyncio
async def test_a_rule_on_a_redirect_target_holds_the_whole_line(sealed):
    ran = await sealed.shell(
        "rm /data/a.txt && echo x > /data/prod/x.txt", session_id="s"
    )
    assert ran.exit_code != 0
    assert ran.decision and "sealed until review" in ran.decision.reason
    assert "/data/a.txt" in await sealed.vfs.readdir("/data")


class _NoCat(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        """Refuse cat, the way a deployment's own policy would.

        Args:
            ctx (CommandContext): the classified command.
        """
        return (
            Deny("cat is refused by policy") if ctx.command == "cat" else None
        )


@pytest_asyncio.fixture()
async def coded():
    workspace = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[_NoCat()]
    )
    await workspace.vfs.write("/data/a.txt", b"a\n")
    await workspace.vfs.write("/data/b.txt", b"b\n")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_a_coded_policy_answers_as_the_command_runs(coded):
    # The pass that judges a line before it runs asks the profile's
    # rules alone; a policy written in code answers pre_command once,
    # as its command runs, so the commands before it have run. A line
    # it refuses whole is pre_execute's.
    ran = await coded.shell("rm /data/a.txt && cat /data/b.txt")
    assert ran.exit_code != 0
    assert ran.stderr == b"cat: Permission denied\n"
    assert ran.decision is not None
    assert ran.decision.reason == "cat is refused by policy"
    assert "/data/a.txt" not in await coded.vfs.readdir("/data")


def _answering(asked: list[str], outcome: Outcome, scope: Scope = Scope.ONCE):
    """A host answering every question the same way, counting what it
    was asked.

    Args:
        asked (list[str]): where each question's id is appended.
        outcome (Outcome): the answer given.
        scope (Scope): how far it reaches.
    """

    async def host(record):
        asked.append(record.id)
        return dataclasses.replace(record, outcome=outcome, scope=scope)

    return host


async def _inline_workspace(on_ask, profile=PROFILE) -> Workspace:
    """The same world as the ``ws`` fixture, with a host that answers an
    ask inline.

    Args:
        on_ask (AskHandler): the host.
        profile (dict): the document session ``s`` runs under.
    """
    workspace = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"r": profile},
        on_ask=on_ask,
    )
    await workspace.shell("mkdir -p /data/prod")
    await workspace.vfs.write("/data/prod/x.txt", b"x\n")
    await workspace.vfs.write("/data/a.txt", b"a\n")
    await workspace.vfs.write("/data/secret.txt", b"s\n")
    workspace.create_session("s", profile="r")
    return workspace


@pytest_asyncio.fixture()
async def inline():
    workspace = await _inline_workspace(_answering([], Outcome.ALLOW))
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_an_answered_ask_does_not_end_the_scan(inline):
    # The host answers the cat inline, so admit admits it. The rest of
    # the line has not been judged yet: reading that admission as "the
    # line is fine" let the later deny run behind an approval, which is
    # the half-line behavior in its worst form, since the agent was
    # told yes.
    ran = await inline.shell(
        "cat /data/secret.txt && rm /data/prod/x.txt", session_id="s"
    )
    assert ran.exit_code != 0
    assert (
        ran.decision and "production data is protected" in ran.decision.reason
    )
    assert b"s\n" not in (ran.stdout or b"")
    assert "/data/prod/x.txt" in await inline.vfs.readdir("/data/prod")


@pytest.mark.asyncio
async def test_a_compound_line_answered_inline_asks_once_per_run():
    # Two passes read this line: the one that judges every command
    # before any runs, and the per-command gate, which runs it. The host
    # answers the cat in the first, and that one nod has to carry the
    # line through the gate, or the human is asked twice for one run. It
    # carries no further: the next identical line is a new question.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        line = "rm /data/a.txt && cat /data/secret.txt"
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\n"
        assert len(asked) == 1
        await ws.vfs.write("/data/a.txt", b"a\n")
        again = await ws.shell(line, session_id="s")
        assert again.exit_code == 0
        assert len(asked) == 2
        # Both grants were spent by the lines they were given for.
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_refused_compound_line_is_refused_again_without_asking():
    # The human who said no is not asked about the agent's immediate
    # retry: the refusal stands to refuse it from the record, is spent
    # by it, and the run after that is an open question again. The same
    # rule the per-command gate keeps for a one-command line.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.DENY))
    try:
        line = "rm /data/a.txt && cat /data/secret.txt"
        for expected in (1, 1, 2):
            ran = await ws.shell(line, session_id="s")
            assert ran.exit_code == 126
            assert len(asked) == expected
        assert "/data/a.txt" in await ws.vfs.readdir("/data")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_handed_to_a_refused_line_does_not_outlive_it():
    # The host allows the cat inline and the pass hands that grant to
    # the gate, which never runs: the rm behind it is refused first.
    # Left standing, the grant would pass the next cat of the secret on
    # a nod given to a line that never ran, so the refusal spends it
    # and the next cat is a question again.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "cat /data/secret.txt && rm /data/prod/x.txt", session_id="s"
        )
        assert ran.exit_code != 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        again = await ws.shell("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_the_run_never_reaches_does_not_outlive_the_line():
    # The host allows the cat inline and the line runs, but the failed
    # cat before it short-circuits the && and the gate that would have
    # spent the grant never runs. The line is over all the same, so the
    # grant is swept with it and the next cat is a question again.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "cat /data/missing && cat /data/secret.txt", session_id="s"
        )
        assert ran.exit_code == 1
        assert ran.stdout == b""
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        again = await ws.shell("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_does_not_outlive_a_line_that_fails_before_it_runs(
    monkeypatch,
):
    # The host allows the cat inline, and then the secret the echo reads
    # cannot be fetched, so the line fails between the preflight and the
    # run: no gate runs at all. The sweep covers that stretch too, or
    # the next cat would run on a nod given to a line that never did.
    monkeypatch.setattr(secrets_registry, "_REGISTERED", {})
    register_secrets("fake", _FakeConfig, _dead_fetch)
    asked: list[str] = []
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"r": PROFILE},
        env={"TOKEN": {"from": "fake", "ref": "r"}},
        on_ask=_answering(asked, Outcome.ALLOW),
    )
    try:
        await ws.vfs.write("/data/secret.txt", b"s\n")
        ws.create_session("s", profile="r")
        ran = await ws.shell(
            "cat /data/secret.txt && echo $TOKEN", session_id="s"
        )
        assert ran.exit_code == 1
        assert ran.stderr == b"TOKEN: cannot fetch from fake\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        again = await ws.shell("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "sleep 0.2 && cat /data/secret.txt &",
        "for i in 1 2; do sleep 0.2 && cat /data/secret.txt & done",
        "if sleep 0.2 && cat /data/secret.txt & then echo yes; fi",
        "until sleep 0.2 && cat /data/secret.txt & do echo no; done",
        "{ sleep 0.2 && cat /data/secret.txt & }",
        "f() { sleep 0.2 && cat /data/secret.txt & }; f",
        "echo λ🙂; f() { sleep 0.2 && cat /data/secret.txt & }; f",
        "eval 'sleep 0.2 && cat /data/secret.txt &'",
        "eval \"eval 'sleep 0.2 && cat /data/secret.txt &'\"",
    ],
)
async def test_a_grant_stays_with_a_background_job_until_it_ends(line):
    # The line returns as soon as the job is launched, long before the
    # job's cat reaches its gate. The grant the host gave the line is
    # the job's to spend, so the line's end leaves it standing and the
    # job's end sweeps it; revoked with the line, the cat would have
    # asked again from inside the job.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert len(asked) == 1
        assert len(ws.decisions.list("s")) == 1
        waited = await ws.shell("wait", session_id="s")
        assert waited.exit_code == 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_out_of_band_grant_stays_with_a_nested_background_job(ws):
    line = "eval 'sleep 0.2 && cat /data/secret.txt > /data/read.txt &'"
    first = await ws.shell(line, session_id="s")
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    ran = await ws.shell(line, session_id="s")
    assert ran.exit_code == 0
    assert len(ws.decisions.list("s")) == 1
    (elsewhere,) = await _judged(ws, "cat /data/secret.txt", "s")
    assert elsewhere.outcome is Outcome.ASK
    waited = await ws.shell("wait", session_id="s")
    assert waited.exit_code == 0
    assert await ws.vfs.read("/data/read.txt") == b"s\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_a_command_spelled_twice_on_a_line_needs_two_answers(ws):
    # One out-of-band answer covers one spelling. Read for both, the
    # first cat would run and spend it before the second was found
    # wanting, which is the half-line the hold exists to prevent: the
    # retry is held whole until the second spelling has its own answer.
    line = "cat /data/secret.txt && cat /data/secret.txt"
    first = await ws.shell(line, session_id="s")
    assert first.exit_code == 126
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    second = await ws.shell(line, session_id="s")
    assert second.exit_code == 126
    assert second.stdout == b""
    assert second.decision is not None and second.decision.kind == "pending"
    assert len(ws.decisions.list("s")) == 2
    await ws.decisions.answer(second.decision.ask_id, Outcome.ALLOW)
    ran = await ws.shell(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_two_lines_judged_at_once_cannot_both_run_on_one_nod(ws):
    # One out-of-band answer, two identical compound lines executed
    # concurrently on the session. The line whose pass claims the grant
    # first runs; the other must be held whole, not run its ls and then
    # find the grant gone at its cat.
    line = "ls /data && cat /data/secret.txt"
    first = await ws.shell(line, session_id="s")
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    ran, held = sorted(
        await asyncio.gather(
            ws.shell(line, session_id="s"), ws.shell(line, session_id="s")
        ),
        key=lambda r: r.exit_code,
    )
    assert ran.exit_code == 0
    assert ran.stdout == b"a.txt\nprod\nsecret.txt\ns\n"
    assert held.exit_code == 126
    assert held.stdout == b""
    assert held.decision is not None and held.decision.kind == "pending"


@pytest.mark.asyncio
async def test_a_grant_given_before_a_refused_line_does_not_outlive_it(ws):
    # The cat was answered out of band while the line waited; its retry
    # is then refused by the rm. That grant was given to this line as
    # surely as an inline one, so the refusal spends it too, and the
    # next cat is a question again rather than a run on a nod given to
    # a line that never ran.
    line = "cat /data/secret.txt && rm /data/prod/x.txt"
    first = await ws.shell(line, session_id="s")
    assert first.exit_code == 126
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    retry = await ws.shell(line, session_id="s")
    assert retry.exit_code != 0
    assert retry.decision is not None
    assert "production data is protected" in retry.decision.reason
    assert ws.decisions.list("s") == ()
    again = await ws.shell("cat /data/secret.txt", session_id="s")
    assert again.exit_code == 126
    assert again.decision is not None and again.decision.kind == "pending"


@pytest.mark.asyncio
async def test_a_cd_in_a_subshell_moves_the_commands_inside_it(ws):
    # The sibling test pins that the cd does not escape the subshell.
    # This one pins the other half: inside it, the cd still applies, so
    # the rule about /data/prod reads x.txt as the file it is. Reading a
    # subshell as "no cd applies" judged the command at the session cwd.
    ran = await ws.shell("(cd /data/prod && rm x.txt)", session_id="s")
    assert ran.exit_code == 1
    assert ran.stderr == b"rm: cannot remove 'x.txt': Permission denied\n"
    assert "/data/prod/x.txt" in await ws.vfs.readdir("/data/prod")


@pytest.mark.asyncio
async def test_a_one_command_line_is_refused_inside_the_shell(ws):
    # Nothing runs before a single command, so there is no hold to buy
    # and the per-command gate answers instead. That is the more
    # faithful answer, not just the cheaper one: the gate refuses from
    # inside the shell, so `2>&1` still moves the message, where this
    # pass answers above the redirect layer and would leave it on
    # stderr.
    ran = await ws.shell("rm /data/prod/x.txt 2>&1", session_id="s")
    assert ran.exit_code == 1
    assert ran.stdout == (
        b"rm: cannot remove '/data/prod/x.txt': Permission denied\n"
    )
    assert ran.stderr in (b"", None)


@pytest.mark.asyncio
async def test_a_grant_claimed_for_a_nested_line_is_the_inner_gates():
    # The pass reads into a substitution, so the cat inside $( ) is
    # judged and its grant claimed before the line runs. The inner line
    # re-enters the executor as a line of its own; with a hand-off
    # unlinked to the outer one, its gate read that claim as another
    # line's reservation and asked the human a second time for one run.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "echo $(cat /data/secret.txt) && ls /data", session_id="s"
        )
        assert ran.exit_code == 0
        assert ran.stdout.startswith(b"s\n")
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_nested_line_runs_on_the_answer_its_outer_line_was_given(ws):
    # Out of band: the question is the outer pass's, and the answer has
    # to reach the gate inside the substitution on the retry.
    line = "echo $(cat /data/secret.txt) && ls /data"
    first = await ws.shell(line, session_id="s")
    assert first.exit_code == 126
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    ran = await ws.shell(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout.startswith(b"s\n")
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_a_nested_line_spelled_twice_costs_two_nods_and_no_more():
    # The outer pass reads the line eval runs and claims one grant per
    # spelling. The inner line's own pass then finds both standing for
    # its two occurrences rather than asking for either again, and its
    # gates spend them.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "eval 'cat /data/secret.txt && cat /data/secret.txt' && ls /data",
            session_id="s",
        )
        assert ran.exit_code == 0
        assert ran.stdout.startswith(b"s\ns\n")
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


class _LineBox(Runtime, LineExecutorMixin):
    name = "sandbox"
    reach = "workspace"
    captures = ("@line",)

    def __init__(self) -> None:
        self.lines: list[str] = []

    async def run_line(
        self, engine, paths, texts, ctx, output, errors
    ) -> RunResult:
        line = ctx.flags["c"]
        self.lines.append(line)
        await output(b"box:" + line.encode())
        return RunResult(exit_code=0)


@pytest.mark.asyncio
async def test_a_whole_line_keeps_its_first_answer_while_its_second_waits():
    # A runtime that takes the line whole has no per-command gate, so
    # its admission pass is the only reader. Spending there, the cat's
    # answer was gone by the time the push's question came back, and
    # every retry asked for the cat again; the answers could never
    # accumulate to a line that runs.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": PROFILE},
        machines=[box],
    )
    try:
        await ws.vfs.write("/data/secret.txt", b"s\n")
        ws.create_session("s", profile="r")
        line = "cat /data/secret.txt && git push origin main"
        first = await ws.shell(line, session_id="s")
        assert first.exit_code == 126
        assert first.decision is not None and first.decision.kind == "pending"
        await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
        second = await ws.shell(line, session_id="s")
        assert second.exit_code == 126
        assert (
            second.decision is not None and second.decision.kind == "pending"
        )
        assert len(ws.decisions.list("s")) == 2
        assert box.lines == []
        await ws.decisions.answer(second.decision.ask_id, Outcome.ALLOW)
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert box.lines == [line]
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_expanded_name_is_explained_as_the_route_reads_it():
    # The executor judges a name once expanded, so explain says nothing
    # about it; a runtime that takes the line whole reads it as typed and
    # refuses it under a rule, and explain then says exactly that.
    line = 'X=echo; "$X" hi'
    for whole, profile, code in (
        (False, PROFILE, 0),
        (True, {}, 0),
        (True, PROFILE, 126),
    ):
        ws = Workspace(
            {"/data/": RAMVFS()},
            mode=MountMode.EXEC,
            profiles={"r": profile},
            machines=[_LineBox()] if whole else None,
        )
        try:
            ws.create_session("s", profile="r")
            said = await _judged(ws, line, "s")
            ran = await ws.shell(line, session_id="s")
            assert ran.exit_code == code
            assert [(e.exit_code, e.stderr) for e in said if e.exit_code] == (
                [(code, await ran.stderr_str())] if code else []
            )
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_line_the_gate_cannot_read_is_explained_as_refused():
    # Under a rule, a whole-line runtime's gate refuses a command whose
    # lines it cannot see into (a sourced file, a bash option mirage does
    # not read), and explain says exactly what the run says.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={
            "r": {
                "commands": {
                    "*": "deny",
                    "bash": "allow",
                    "source": "allow",
                    "rm": "allow",
                }
            }
        },
        machines=[_LineBox()],
    )
    try:
        ws.create_session("s", profile="r")
        for line in (
            "source /data/f.sh",
            "bash --restricted -c 'rm /data/x'",
            "bash --rcfile $SKIP --version -c 'rm /data/x'",
            "bash --init-file $SKIP --help -c 'rm /data/x'",
            "bash --rcfile missing-* --version -c 'rm /data/x'",
        ):
            said = await _judged(ws, line, "s")
            ran = await ws.shell(line, session_id="s")
            assert ran.exit_code == 126
            assert [(e.exit_code, e.stderr) for e in said if e.exit_code] == [
                (126, await ran.stderr_str())
            ]
    finally:
        await ws.close()


class _NoHostname(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        """Refuse hostname, the way a deployment's own policy would.

        Args:
            ctx (CommandContext): the classified command.
        """
        return Deny("no hostname") if ctx.command == "hostname" else None


class _ReadOnly(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        """Refuse writes, a policy with no say at pre_command.

        Args:
            ctx (VfsContext): the op.
        """
        return Deny("read only") if ctx.write else None


NO_HOSTNAME = """
def pre_command(ctx):
    if ctx['command'] == 'hostname':
        return {'kind': 'deny', 'reason': 'no hostname'}
    return None
"""

HIDDEN_HOSTNAME = (
    "X=hostname; $X",
    "sh -c 'X=hostname; $X'",
    'eval "$(echo host)name"',
    "H=host; eval ${H}name",
    "echo hostname | sh",
    "echo hostname | bash",
    "printf hostname > /data/s; sh /data/s",
    "source /dev/stdin <<< hostname",
    "xargs <<< hostname",
    "hostnam?",
    "env hostnam?",
)


@pytest.mark.asyncio
@pytest.mark.parametrize("scripted", [False, True])
async def test_a_policy_refuses_what_a_whole_line_gate_cannot_read(scripted):
    # Off a whole-line runtime a pre_command policy judges each command
    # once its words are expanded; such a runtime expands them itself, so
    # its gate refuses what it cannot read for a policy as for a rule.
    box = _LineBox()
    policy = {"pre_command": [{"script": ScriptSource(NO_HOSTNAME)}]}
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": {"policy": policy} if scripted else {}},
        policies=[] if scripted else [_NoHostname()],
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        for line in HIDDEN_HOSTNAME:
            said = await ws.explain(line, "s")
            ran = await ws.shell(line, session_id="s")
            assert ran.exit_code == 126, line
            assert (said.exit_code, said.stderr) == (
                ran.exit_code,
                await ran.stderr_str(),
            )
        assert box.lines == []
    finally:
        await ws.close()


ANOTHER_SPELLING = (
    "env -C tmp hostname",
    "env --chdir tmp hostname",
    "env --chd tmp hostname",
    "env -a x hostname",
    "env --argv0 x hostname",
    "env -vC tmp hostname",
    "trap hostname EXIT",
    "trap 'hostname' DEBUG; :",
    "coproc hostname",
    "PS4='$(hostname)'; set -x; :",
    "export PS4='$(hostname)'; set -x; :",
    "BASH_ENV=/data/e bash -c :",
    "ENV=/data/e sh -i",
    "env PS4='$(hostname)' bash -xc :",
    "eval \"PS4='\\$(hostname)'\"; set -x; :",
    "hash -p /bin/hostname ls; ls",
    "enable -f /data/x.so hostname",
    "alias x=hostname\nx",
    "read PS4 <<< '$(hostname)'; set -x; :",
    "printf -v PS4 '$(hostname)'; set -x; :",
    "mapfile -t PS4 <<< x; set -x; :",
    "for PS4 in x; do set -x; :; done",
    "declare -n r=PS4; r=x; set -x; :",
    "read BASH_ENV <<< /data/e; bash -c :",
    "env 'BASH_FUNC_ls%%=() { hostname; }' bash -c ls",
    "bash -ic :",
    "bash -lc :",
    "sh --login -c :",
    "PS4[0]='$(hostname)'; set -x; :",
    "read 'PS4[0]' <<< x; set -x; :",
    "read -a PS4 <<< x; set -x; :",
    "command -p printf -v PS4 '$(hostname)'; set -x; :",
    "empty=; printf $empty -v PS4 '$(hostname)'; set -x; :",
    "v=p; command -$v printf -v PS4 '$(hostname)'; set -x; :",
    "v=p; command -$v hostname",
    "unset PS4; : ${PS4:='$(hostname)'}; set -x; :",
    "declare -n r; r=PS4; r=x; set -x; :",
    'v=PS4; printf -v "$v" x; set -x; :',
    "BASH_CMDS[ls]=/bin/hostname; ls",
    "BASH_ALIASES[x]=hostname\nx",
    "bash -c -l :",
    "bash -c -x hostname",
    "env -a -bash bash -c :",
    "exec -l bash -c :",
    "exec -a -bash bash -c :",
    'a=x=hostname; alias "$a"\nx',
    "v='PS4=$(hostname)'; declare \"$v\"; set -x; :",
    "declare PS4\\='$(hostname)'; set -x; :",
    "o=l; exec -$o bash -c :",
    "o=l; env -$o bash -c :",
    "o=p; hash -$o /bin/hostname ls; ls",
    "o='-p /bin/hostname'; hash $o ls; ls",
    "builtin declare 'PS4=$(hostname)'; set -x; :",
    "command typeset 'PS4=$(hostname)'; set -x; :",
    "builtin export 'PS4=$(hostname)'; set -x; :",
    "export -p 'PS4=$(hostname)'; set -x; :",
    'n=-bash; exec -a "$n" bash -c :',
    'n=-bash; env -a "$n" bash -c :',
    'k=BASH_ENV; env "$k=/data/e" bash -c :',
    "declare PS4='$(hostname)' -p; set -x; :",
    "declare -p x=$(read PS4 <<< x); set -x; :",
    "p=r; read -$p PS4 <<< '$(hostname)'; set -x; :",
    "bash -oe nounset -i -c :",
    "empty=; trap --$empty hostname EXIT",
)

STILL_RUNS = (
    "trap 'rm -f /data/t' EXIT; echo hi",
    "trap - EXIT; trap -p",
    "coproc echo hi",
    "hash -r; alias",
    "ENV=production echo hi",
    "printf PS4",
    "bash -c 'echo hi'",
    "bash -c ': -l'",
    "exec -a name echo hi",
    "printf '%s\\n' -v PS4",
    "command -v read PS4",
)

# Lines a rule leaves alone (a coded policy refuses their `$` words).
STILL_RUNS_UNDER_RULES = (
    "read -r line < /data/f",
    "printf -v x %s y",
    "for f in a b; do echo hi; done",
    "declare -i n=1",
    "g() { local x=1; }; g",
    'read -p "Name: $USER " ans < /data/f',
    'getopts ":ab:" opt "$@"',
    "export -n FOO",
    'g() { local x="$1"; }; g a',
    "declare -p PS4",
    "typeset -F PS4",
    "declare -n -p PS4",
    "declare -p PS4=after",
)


@pytest.mark.asyncio
@pytest.mark.parametrize("coded", [False, True])
async def test_a_whole_line_gate_reads_what_another_spelling_runs(coded):
    # Each line runs hostname on the machine by a spelling the gate
    # follows, so a deny of hostname refuses it, in code or as a rule.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": {} if coded else {"commands": {"hostname": "deny"}}},
        policies=[_NoHostname()] if coded else [],
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        for line in ANOTHER_SPELLING:
            said = await ws.explain(line, "s")
            ran = await ws.shell(line, session_id="s")
            assert ran.exit_code == 126, line
            assert (said.exit_code, said.stderr) == (
                ran.exit_code,
                await ran.stderr_str(),
            )
        assert box.lines == []
        still = STILL_RUNS + (() if coded else STILL_RUNS_UNDER_RULES)
        for line in still:
            assert (await ws.shell(line, session_id="s")).exit_code == 0, line
        assert box.lines == list(still)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, allowed",
    [
        ("trap hostname EXIT", ("trap", "echo")),
        ("PS4='$(hostname)'; set -x; echo hi", ("set", "echo", ":")),
        ("coproc hostname", ("coproc",)),
    ],
)
async def test_an_allow_list_holds_against_a_line_another_spelling_runs(
    line, allowed
):
    # A trap's action, a coproc's command and a PS4 the trace expands are
    # what the line runs: a closed list that names none of them refuses.
    box = _LineBox()
    commands = {"*": "deny", **{name: "allow" for name in allowed}}
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": {"commands": commands}},
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        said = await ws.explain(line, "s")
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 126
        assert (said.exit_code, said.stderr) == (126, await ran.stderr_str())
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["PS4", "BASH_FUNC_ls%%"])
@pytest.mark.parametrize("coded", [False, True])
async def test_a_hook_the_session_exports_holds_a_whole_line(name, coded):
    # The machine's shell gets the session's exported environment, so a
    # hook an earlier line exported runs there on a line that reads clean.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": {} if coded else {"commands": {"hostname": "deny"}}},
        policies=[_NoHostname()] if coded else [],
        machines=[box],
    )
    try:
        session = ws.create_session("s", profile="r")
        seed_var(session, name, "$(hostname)")
        assert (await ws.shell("set -x; :", session_id="s")).exit_code == 0
        set_attr(session, name, VarAttr.EXPORT)
        said = await ws.explain("set -x; :", "s")
        ran = await ws.shell("set -x; :", session_id="s")
        assert ran.exit_code == 126
        assert (said.exit_code, said.stderr) == (126, await ran.stderr_str())
        assert box.lines == ["set -x; :"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_env_option_cluster_hands_its_value_the_rest_of_it():
    # GNU getopt gives `-Cu` the value `u`, so env runs `tmp`: an allow
    # list naming env and hostname refuses it and admits `-C tmp hostname`.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={
            "r": {
                "commands": {"*": "deny", "env": "allow", "hostname": "allow"}
            }
        },
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        refused = await ws.shell("env -Cu tmp hostname", session_id="s")
        assert refused.exit_code == 126
        admitted = await ws.shell("env -C tmp hostname", session_id="s")
        assert admitted.exit_code == 0
        assert box.lines == ["env -C tmp hostname"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_runs_as_typed_with_no_policy_at_pre_command():
    # Mirage's own pre_command policies and a policy with no say at
    # pre_command leave the line as it was: the runtime takes it whole.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        policies=[_ReadOnly()],
        machines=[box],
    )
    try:
        for line in HIDDEN_HOSTNAME:
            assert (await ws.shell(line)).exit_code == 0, line
        assert box.lines == list(HIDDEN_HOSTNAME)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_policy_admits_a_test_pattern_the_runtime_matches_as_typed():
    # `[[ ]]` expands no pathname, and a pattern side with no expansion
    # in it is matched as typed, so a policy reads it as the runtime will.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        policies=[_NoHostname()],
        machines=[box],
    )
    try:
        typed = ("[[ abc == a* ]]", "[[ abc =~ ^a.* ]]", "[[ -n a* ]]")
        for line in typed:
            assert (await ws.shell(line)).exit_code == 0, line
        assert (await ws.shell("[[ abc == $p* ]]")).exit_code == 126
        assert box.lines == list(typed)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_rule_refuses_a_command_name_the_runtime_globs():
    # The runtime turns `hostnam?` into `hostname` itself, so under a
    # rule the gate refuses a name pattern as it refuses `$X`.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": {"commands": {"hostname": "deny"}}},
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        for line in ("hostnam?", "cd /data; hostnam?"):
            ran = await ws.shell(line, session_id="s")
            assert ran.exit_code == 126, line
        assert box.lines == []
    finally:
        await ws.close()


SEALED_READS = {
    "commands": {
        "*": "deny",
        "cat": [
            "allow",
            {
                "decision": "deny",
                "reason": "sealed",
                "paths": ["/data/secret*"],
            },
        ],
        "cd": "allow",
        "grep": [
            "allow",
            {
                "decision": "deny",
                "reason": "sealed",
                "paths": ["/data/secret*"],
            },
        ],
    }
}


@pytest.mark.asyncio
async def test_explain_says_what_a_whole_line_gate_refuses_past_the_chain():
    # A runtime that takes the line whole walks, globs and changes
    # directory where no gate follows, so under a path rule its gate
    # refuses a walk, a glob and a command after a cd it cannot follow;
    # explain said each would run. A cd it can follow moves the path the
    # rule reads, which the gate read in the session's cwd and ran.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": SEALED_READS},
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        for line, reason in (
            ("grep -r x /data", "walks a tree the gate cannot follow"),
            ("cat /data/*.txt", "expands a pattern only the runtime can read"),
            ('cd "$D" && cat notes', "runs after a cd the gate cannot follow"),
            ("cd /data && cat secret", "sealed"),
        ):
            said = await ws.explain(line, "s")
            ran = await ws.shell(line, session_id="s")
            assert ran.decision is not None and ran.decision.reason == reason
            assert (said.outcome, said.reason) == (Outcome.DENY, reason)
            assert (said.exit_code, said.stderr) == (
                ran.exit_code,
                await ran.stderr_str(),
            )
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_is_judged_wherever_a_cd_may_leave_it():
    # A cd may be skipped or fail, and a loop runs its body again from
    # where it ended: the gate judged each command only where the walk
    # predicted it stood, and admitted a read of the secret the box made
    # from the cwd the cd never left. A cd in a pipeline or sent to the
    # background moves no later run of the loop.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={
            "r": {
                "commands": {
                    **SEALED_READS["commands"],
                    "false": "allow",
                    "true": "allow",
                }
            }
        },
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        for cwd, line, reason in (
            ("/data", "false && cd /data/public; cat secret", "sealed"),
            ("/data", "cd /data/public; cat secret", "sealed"),
            (
                "/data/public",
                "for i in 1 2; do cat secret; cd /data; done",
                "runs after a cd the gate cannot follow",
            ),
        ):
            ws.get_session("s").cwd = cwd
            said = await ws.explain(line, "s")
            ran = await ws.shell(line, session_id="s")
            assert ran.decision is not None and ran.decision.reason == reason
            assert (said.outcome, said.reason) == (Outcome.DENY, reason)
        assert box.lines == []
        line = "for i in 1 2; do cd /data | true; cd /data & cat notes; done"
        said = await ws.explain(line, "s")
        ran = await ws.shell(line, session_id="s")
        assert (said.exit_code, ran.decision) == (0, None)
        assert box.lines == [line]
    finally:
        await ws.close()


class _SealedSecret(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if any(p.virtual == "/data/secret.txt" for p in ctx.paths):
            return Deny("sealed")
        return None


SEALED_RULE = {
    "commands": {
        "*": [
            "allow",
            {
                "decision": "deny",
                "reason": "sealed",
                "paths": ["/data/secret.txt"],
            },
        ]
    }
}

# What a path check reads must be the file the machine opens: its shell
# expands `~` with its own HOME and user database, and `//` is `/`.
MACHINE_PATHS = (
    "HOME=/data; cat ~/secret.txt",
    "export HOME=/data; cat ~/secret.txt",
    "HOME=/data; eval 'cat ~/secret.txt'",
    "cat ~backup/secret.txt",
    "cat //data/secret.txt",
    "diff --from-file=/data/secret.txt /data/pub",
    "diff --to-file=/data/secret.txt /data/pub",
    "read HOME <<< /data; cat ~/secret.txt",
    "printf -v HOME /data; cat ~/secret.txt",
    "dd if=~/secret.txt",
    "env -C /data cat secret.txt",
    "env --chdir=/data cat secret.txt",
    "HOME[0]=/data; cat ~/secret.txt",
    "bash -c 'HOME=/data; cat ~/secret.txt'",
    "declare -n h; h=HOME; h=/data; cat ~/secret.txt",
    "env -C /tmp HOME=/data bash -c 'cat ~/secret.txt'",
    "env -v HOME=/data bash -c 'cat ~/secret.txt'",
)
MACHINE_WRITES = (
    "find /data/pub -fprint /data/secret.txt",
    "find /data/pub -fprint0 /data/secret.txt",
    "find /data/pub -fls /data/secret.txt",
    "find -O3 /data/pub -fprint /data/secret.txt",
)


@pytest.mark.asyncio
@pytest.mark.parametrize("coded", [False, True])
async def test_a_path_check_reads_the_file_a_whole_line_opens(coded):
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": {} if coded else SEALED_RULE},
        policies=[_SealedSecret()] if coded else [],
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        lines = MACHINE_PATHS + (MACHINE_WRITES if coded else ())
        for line in lines:
            said = await ws.explain(line, "s")
            ran = await ws.shell(line, session_id="s")
            assert ran.exit_code != 0, line
            assert (said.exit_code, said.stderr) == (
                ran.exit_code,
                await ran.stderr_str(),
            ), line
        assert box.lines == []
        still = (
            "cat ~/secret.txt",
            "cat ~root/secret.txt",
            "env -C /data cat other.txt",
            'echo x="a:~"',
        )
        for line in still:
            assert (await ws.shell(line, session_id="s")).exit_code == 0
        assert box.lines == list(still)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_coded_policy_judges_a_whole_line_where_it_may_stand():
    # With no rule in force a coded policy is a whole line's only gate:
    # it was shown only the cwd a skipped cd predicted, nothing at all
    # for a name only the runtime expands, and none of the words after a
    # line that may move the cwd.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        policies=[_SealedSecret()],
        machines=[box],
    )
    try:
        ws.get_session(ws.default_session_id).cwd = "/data"
        for line in (
            "false && cd /data/public; cat secret.txt",
            '"$CMD" /data/secret.txt',
            "eval ':'; cat secret.txt",
        ):
            said = await ws.explain(line)
            ran = await ws.shell(line)
            assert ran.decision is not None and ran.decision.reason == "sealed"
            assert (said.outcome, said.reason) == (Outcome.DENY, "sealed")
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_nested_loops_are_read_once_each():
    # A loop is read for a cd before it is walked; walking it to find
    # out doubled the work at every level, so 22 nested loops walked the
    # innermost command four million times before the line ran.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        line = "for a in; do " * 22 + "true" + "; done" * 22
        started = time.perf_counter()
        said = await ws.explain(line)
        assert said.exit_code == 0
        assert time.perf_counter() - started < 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_judges_a_held_line_as_its_runtime_takes_it():
    # A line the rules hold stays on its static bindings, whose runtime
    # takes it whole and refuses the walk before asking; explain read
    # the held line command by command and offered an approval the run
    # never asks for.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={
            "r": {
                "commands": {
                    "*": "deny",
                    "grep": [
                        "allow",
                        {
                            "decision": "ask",
                            "reason": "nod",
                            "paths": ["/data"],
                        },
                    ],
                }
            }
        },
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        line = "grep -r x /data"
        reason = "walks a tree the gate cannot follow"
        said = await ws.explain(line, "s")
        ran = await ws.shell(line, session_id="s")
        assert ran.decision is not None and ran.decision.reason == reason
        assert (said.outcome, said.reason) == (Outcome.DENY, reason)
        assert box.lines == []
    finally:
        await ws.close()


def _commands(node: ShellNode) -> list[CommandExplanation]:
    """Every command an explained tree holds, nested scopes included.

    Args:
        node (ShellNode): the tree's root.
    """
    out: list[CommandExplanation] = []
    for child in node.children:
        if isinstance(child, CommandExplanation):
            out.append(child)
            for scope in child.children:
                out.extend(_commands(scope))
        else:
            out.extend(_commands(child))
    return out


@pytest.mark.asyncio
async def test_explain_reads_a_line_as_the_runtime_it_is_placed_on():
    # A line placed on the workspace meets the per-command gate, which
    # reads a name once expanded, though the default runtime takes lines
    # whole; explain read the default and refused the name as unreadable.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": PROFILE},
        machines=[_LineBox()],
        route_policy=lambda ctx: "workspace",
    )
    try:
        ws.create_session("s", profile="r")
        line = 'X=echo; "$X" hi'
        said = await ws.explain(line, "s")
        ran = await ws.shell(line, session_id="s")
        assert (ran.exit_code, ran.stdout) == (0, b"hi\n")
        assert said.exit_code == 0
        assert [c.exit_code for c in _commands(said.node)] == [0] * len(
            _commands(said.node)
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, outcome, count",
    [
        ("cd /data && echo hi | cat", Outcome.ALLOW, 3),
        ("cd /data && git push origin main", Outcome.ASK, 2),
    ],
)
async def test_explain_names_the_line_runtime_for_every_command_it_takes(
    line, outcome, count
):
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": PROFILE},
        machines=[_LineBox()],
    )
    try:
        ws.create_session("s", profile="r")
        said = await ws.explain(line, "s")
        machines = [c.machine for c in _commands(said.node)]
        assert said.outcome == outcome
        assert machines == ["sandbox"] * count
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_path_the_pass_cannot_read_is_left_to_the_gate():
    # Read as typed in the cwd the pass last knew, `$F` and a relative
    # word after `cd "$d"` matched the rule's glob, refusing whole lines
    # that remove only an allowed file, and `.` read as a mount root. A
    # path a word names outright stays read though it is the lost cwd;
    # a grep pattern spelling that cwd names no path.
    sealed = {
        "commands": {
            "grep": {
                "decision": "deny",
                "reason": "sealed",
                "paths": ["/data/prod"],
            }
        }
    }
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": PROFILE, "g": sealed},
    )
    try:
        ws.create_session("s", profile="r")
        ws.create_session("g", profile="g")
        ws.create_session("t")
        await ws.shell(
            "mkdir /data/prod; touch /data/x /data/w", session_id="t"
        )
        for session, line, code in (
            ("s", "cd /data/prod; F=/data/x; rm $F; echo ok", 0),
            ("s", 'cd /data/prod; d=/data; cd "$d" && rm w; echo ok', 0),
            ("s", 'd=/data; cd "$d" && rm /data/prod/y; echo ok', 1),
            (
                "s",
                'cd /data/prod; mkdir v; cd v; d=/data; cd "$d" && rm -r '
                "/data/prod/v; echo ok",
                1,
            ),
            (
                "g",
                'mkdir -p /data/q; cd /data/prod; d=/data/q; cd "$d" && '
                "grep -r -e /data/prod; echo ok",
                0,
            ),
            (
                "t",
                'cd /data; d=prod; cd "$d" && tar -cf /data/t.tar . && echo ok',
                0,
            ),
        ):
            said = await _judged(ws, line, session)
            ran = await ws.shell(line, session_id=session)
            err = await ran.stderr_str()
            assert ran.exit_code == code, err
            assert ran.stdout == (b"" if code else b"ok\n")
            assert [(e.exit_code, e.stderr) for e in said if e.exit_code] == (
                [(code, err)] if code else []
            )
    finally:
        await ws.close()


class _NoConsoles(RAMExecutionStore):
    """A job store that cannot open a console."""

    def console(self, name: str) -> ConsoleStore:
        raise RuntimeError("no console")


@pytest.mark.asyncio
async def test_a_job_that_cannot_be_submitted_hands_its_borrow_back():
    # The job borrows the line's hand-off before it is submitted, and
    # its runner hands it back. A submission that fails starts no
    # runner, so the borrow has to be handed back at the failure, or
    # the hand-off stays a holder short of release for good and its
    # grant is neither spent nor on offer to any later line.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        store = ws.job_table.store
        ws.job_table.store = _NoConsoles()
        ran = await ws.shell("cat /data/secret.txt & ls /data", session_id="s")
        assert ran.exit_code != 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
        ws.job_table.store = store
        again = await ws.shell("cat /data/secret.txt", session_id="s")
        assert again.exit_code == 0
        assert again.stdout == b"s\n"
        assert len(asked) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_word_that_expands_to_a_judged_command_does_not_run_on_its_nod(
    ws,
):
    # The pass reads the literal cat and claims the answer for it; the
    # first cat's operand expands at run time into the same command.
    # Read by spelling, that gate found the literal's grant and read the
    # secret before its own question was ever put, and the literal then
    # asked again. Bound to its occurrence, the grant is the literal's
    # alone: the expanded command asks, its question holds the line,
    # and the retry runs both on their own answers.
    line = "F=/data/secret.txt; cat $F && cat /data/secret.txt"
    first = await ws.shell(line, session_id="s")
    assert first.exit_code == 126
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    second = await ws.shell(line, session_id="s")
    assert second.exit_code == 126
    assert second.stdout == b""
    assert second.decision is not None and second.decision.kind == "pending"
    assert len(ws.decisions.list("s")) == 2
    await ws.decisions.answer(second.decision.ask_id, Outcome.ALLOW)
    ran = await ws.shell(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_one_body_under_two_words_is_two_occurrences():
    # The same substitution twice on a line is two questions, and each
    # nested line spends its own: the second body cannot be answered by
    # the first body's nod, nor ask a third time.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "echo $(cat /data/secret.txt) $(cat /data/secret.txt) && ls /data",
            session_id="s",
        )
        assert ran.exit_code == 0
        assert ran.stdout.startswith(b"s s\n")
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_words_handed_on_by_command_are_one_question():
    # command re-runs its operands as one line, joined with shlex so an
    # operand holding a space survives the re-parse. The pass has to
    # read the words the same way, or the occurrence it claims the
    # answer for is not the one the nested gate computes, and the cat
    # asks a second time after the echo has already run.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        await ws.vfs.write("/data/secret file", b"s\n")
        ran = await ws.shell(
            "echo x && command cat '/data/secret file'", session_id="s"
        )
        assert ran.exit_code == 0
        assert ran.stdout == b"x\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_held_line_keeps_its_jobs_grant_reserved(ws):
    # The job is launched on the grant the pass claimed for its cat,
    # and the foreground cat expands into a question that holds the
    # line. A hold that let go of the job's grant with the line's left
    # it standing for anyone while the job slept, so a line judged then
    # ran on it and the job asked again. The grant is the job's own:
    # the other line asks, and the job runs on its nod.
    line = "F=/data/secret.txt; sleep 0.5 && cat /data/secret.txt & cat $F"
    first = await ws.shell(line, session_id="s")
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    held = await ws.shell(line, session_id="s")
    assert held.exit_code == 126
    assert held.decision is not None and held.decision.kind == "pending"
    other = await ws.shell("cat /data/secret.txt", session_id="s")
    assert other.exit_code == 126
    assert other.decision is not None and other.decision.kind == "pending"
    waited = await ws.shell("wait", session_id="s")
    assert waited.exit_code == 0
    assert len(ws.decisions.pending("s")) == len(ws.decisions.list("s"))


@pytest.mark.asyncio
async def test_touching_backtick_pairs_hold_the_line_as_the_lines_they_run(ws):
    # Judged on a spelling that is not what runs, the pass saw no
    # readable cat and nothing held the line: the echo ran, and only
    # then did the cat's gate, running its own pair as a line, ask.
    # Read as the lines the evaluator runs, the pass asks first and
    # holds the whole line.
    line = "echo x && echo `cat /data/secret.txt` `echo ok`"
    first = await ws.shell(line, session_id="s")
    assert first.exit_code == 126
    assert first.stdout == b""
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    ran = await ws.shell(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout == b"x\ns ok\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_two_backtick_pairs_of_one_node_are_two_occurrences():
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "echo `cat /data/secret.txt` `cat /data/secret.txt`",
            session_id="s",
        )
        assert ran.exit_code == 0
        assert ran.stdout == b"s s\n"
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_operand_holding_a_multibyte_character_is_one_question():
    # The nested gate places the cat by the parser's byte offsets, and
    # the occurrence the pass claimed for it ended in code points, one
    # short per multibyte character: the grant was hidden from the gate
    # and the cat asked a second time after the echo had already run.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        await ws.vfs.write("/data/secrét", b"s\n")
        ran = await ws.shell(
            "echo x && command cat /data/secrét", session_id="s"
        )
        assert ran.exit_code == 0
        assert ran.stdout == b"x\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_pair_after_a_multibyte_character_runs_on_its_own_nod():
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "echo `echo é` `cat /data/secret.txt`", session_id="s"
        )
        assert ran.exit_code == 0
        assert ran.stdout == "é s\n".encode()
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_held_pair_holding_a_multibyte_character_runs_on_its_grant(
    ws,
):
    # The engine places a pair in bytes of its region, as the pass does;
    # counted apart, the grant is hidden from the gate and the line asks
    # again.
    await ws.vfs.write("/data/secrét", b"s\n")
    line = "echo x && echo `cat /data/secrét`"
    first = await ws.shell(line, session_id="s")
    assert first.decision is not None and first.decision.kind == "pending"
    await ws.decisions.answer(first.decision.ask_id, Outcome.ALLOW)
    ran = await ws.shell(line, session_id="s")
    assert ran.exit_code == 0
    assert ran.stdout == b"x\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "for i in 1 2; do touch /data/mark.txt; cat /data/secret.txt; done",
        "for i in 1 2; do cat /data/secret.txt; done",
    ],
)
async def test_a_loop_runs_every_visit_of_a_command_on_one_nod(line):
    # The loop body is one place on the line, visited twice. The grant
    # for the cat is bound to that place until the line ends, whether
    # the pass claimed it or the first gate to reach it did (the pass
    # leaves a one-command body to the gate), so the second iteration
    # runs on it instead of asking again after the touch ran once more.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_held_loop_replays_on_the_one_answer_it_was_given(ws):
    line = "for i in 1 2; do touch /data/mark.txt; cat /data/secret.txt; done"
    first = await ws.shell(line, session_id="s")
    assert first.exit_code == 126
    assert "/data/mark.txt" not in await ws.vfs.readdir("/data")
    (pending,) = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW)
    again = await ws.shell(line, session_id="s")
    assert again.exit_code == 0
    assert again.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "touch /data/mark.txt && echo /data/secret.txt | xargs cat",
        "F=/data/secret.txt; touch /data/mark.txt; cat $F",
    ],
)
async def test_a_spelling_the_runtime_completes_is_asked_about_at_the_gate(
    line,
):
    # The pass reads `xargs cat` as a bare cat and `cat $F` as the word
    # typed, and the gate reads neither: xargs appends its items and $F
    # expands. A question asked here about either spelling would be
    # answered for words that never run, and the gate would ask again
    # about the words that do, so the pass leaves the question to the
    # gate and the human is asked once, about the real operand. The
    # touch has run by then; the hold does not reach a spelling the
    # runtime completes.
    seen: list[tuple[str, ...]] = []

    async def host(record):
        seen.append((record.command, *record.argv))
        return dataclasses.replace(
            record, outcome=Outcome.ALLOW, scope=Scope.ONCE
        )

    ws = await _inline_workspace(host, ASK_CAT)
    try:
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\n"
        assert seen == [("cat", "/data/secret.txt")]
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "touch /data/mark.txt && echo /data/secret.txt | xargs cat",
        "F=/data/secret.txt; touch /data/mark.txt; cat $F",
    ],
)
async def test_a_deny_on_a_spelling_the_runtime_completes_holds_the_line(line):
    # A deny speaks on the command name alone, which the pass can read
    # whatever the runtime appends, so it still refuses the whole line
    # before the touch runs.
    ws = await _inline_workspace(_answering([], Outcome.ALLOW), DENY_CAT)
    try:
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 126
        assert ran.stderr == b"cat: Permission denied\n"
        assert "/data/mark.txt" not in await ws.vfs.readdir("/data")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_every_batch_xargs_hands_on_runs_on_one_nod():
    # Each batch xargs hands on is a nested line of its own, evaluated
    # from the one xargs node, so every batch's cat stands at the same
    # place. What the first batch's gate claims is handed to the outer
    # line when the batch ends, and the second batch runs on it.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "printf '/data/secret.txt /data/secret.txt' | xargs -n1 cat",
            session_id="s",
        )
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_held_xargs_line_replays_every_batch_on_one_answer(ws):
    line = "printf '/data/secret.txt /data/secret.txt' | xargs -n1 cat"
    first = await ws.shell(line, session_id="s")
    assert first.decision is not None and first.decision.kind == "pending"
    (pending,) = ws.decisions.pending()
    await ws.decisions.answer(pending.id, Outcome.ALLOW)
    again = await ws.shell(line, session_id="s")
    assert again.exit_code == 0
    assert again.stdout == b"s\ns\n"
    assert ws.decisions.list("s") == ()


@pytest.mark.asyncio
async def test_every_job_a_loop_launches_runs_on_one_nod():
    # The loop body launches a job from one place twice through eval.
    # Each job takes a copy of the grant
    # claimed for that place, the line's end leaves the grant standing
    # while a job holds it, and the last job's end spends it.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "for i in 1 2; do eval 'sleep 0.2 && "
            "cat /data/secret.txt >> /data/read.txt &'; done",
            session_id="s",
        )
        assert ran.exit_code == 0
        assert len(asked) == 1
        assert len(ws.decisions.list("s")) == 1
        waited = await ws.shell("wait", session_id="s")
        assert waited.exit_code == 0
        assert await ws.vfs.read("/data/read.txt") == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "sleep 0.2 && eval 'cat /data/secret.txt' &",
        "sleep 0.2 && echo $(cat /data/secret.txt) &",
    ],
)
async def test_a_line_a_job_evaluates_late_stands_under_the_job(line):
    # The job outlives the line, and only then hands a line on (eval) or
    # expands one ($( )). That line stands under the job's hand-off,
    # which holds the grant the pass claimed for its cat, so the gate
    # runs on it and asks nothing more, and the job's end spends it.
    # Under the finished line's hand-off instead, the gate could not see
    # the job's grant and asked again, and what it then claimed went
    # back to a hand-off nothing revokes, standing for good.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert len(asked) == 1
        waited = await ws.shell("wait", session_id="s")
        assert waited.exit_code == 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_what_a_jobs_late_gate_claims_is_the_jobs_to_spend():
    # xargs completes cat's words at run time, so the pass leaves the
    # question to the gate, which asks from inside the job after the
    # line has returned. The answer is claimed for the batch's line and
    # handed up to the job's hand-off, whose end spends it; parked on
    # the finished line's, it would stand unspent for good.
    asked: list[str] = []
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    try:
        ran = await ws.shell(
            "sleep 0.2 && echo /data/secret.txt | xargs cat &", session_id="s"
        )
        assert ran.exit_code == 0
        assert asked == []
        waited = await ws.shell("wait", session_id="s")
        assert waited.exit_code == 0
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


async def _aliased(asked: list[str]) -> Workspace:
    """The inline world with ``c`` an alias for the guarded read and
    ``d`` an alias for ``c``, defined on a line of their own so the
    lines after it expand them.

    Args:
        asked (list[str]): where each question's id is appended.
    """
    ws = await _inline_workspace(_answering(asked, Outcome.ALLOW))
    defined = await ws.shell(
        "shopt -s expand_aliases; alias c='cat /data/secret.txt' d=c",
        session_id="s",
    )
    assert defined.exit_code == 0
    return ws


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["c && c", "c; c", "eval 'c && c'", "d && d"])
async def test_each_invocation_of_an_alias_is_a_place_of_its_own(line):
    # An invocation reads its rewritten line as a line of its own under
    # the word that named it, so two invocations on one line are two
    # places and two questions, as the spelled-out `cat ... && cat ...`
    # is, through an alias of an alias as well. Run on the line's own
    # hand-off instead, both reads stood at the same offsets of the
    # same text, and the second ran on the first's nod.
    asked: list[str] = []
    ws = await _aliased(asked)
    try:
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 2
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_one_alias_invocation_reached_twice_runs_on_one_nod():
    # A loop body visits one invocation twice: the same word at the same
    # place reads the same line, so the second visit runs on what the
    # first claimed and handed back to the line, and the line's end
    # spends it.
    asked: list[str] = []
    ws = await _aliased(asked)
    try:
        ran = await ws.shell("for i in 1 2; do c; done", session_id="s")
        assert ran.exit_code == 0
        assert ran.stdout == b"s\ns\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_alias_a_job_runs_late_hands_its_claim_to_the_job():
    # The job expands the alias after the line has returned, so the
    # rewritten line stands under the job's hand-off, not the finished
    # line's: what its gate claims is handed to the job, and the job's
    # end spends it rather than leaving it standing for good.
    asked: list[str] = []
    ws = await _aliased(asked)
    try:
        ran = await ws.shell("sleep 0.2 && c &", session_id="s")
        assert ran.exit_code == 0
        waited = await ws.shell("wait", session_id="s")
        assert waited.exit_code == 0
        assert waited.stdout == b"s\n"
        assert len(asked) == 1
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mapfile_callback_is_asked_about_at_the_gate():
    # mapfile runs its callback with the index and the record after it,
    # so the callback as typed is a spelling the runtime completes, like
    # the words xargs hands on: the pass leaves its question to the
    # gate, which asks once about the words that run.
    seen: list[tuple[str, ...]] = []

    async def host(record):
        seen.append((record.command, *record.argv))
        return dataclasses.replace(
            record, outcome=Outcome.ALLOW, scope=Scope.ONCE
        )

    ws = await _inline_workspace(host, ASK_CAT)
    try:
        await ws.shell(
            "touch /data/mark.txt && "
            "printf 'x\\n' | mapfile -t -c 1 -C 'cat /data/secret.txt'",
            session_id="s",
        )
        assert seen == [("cat", "/data/secret.txt", "0", "x")]
        assert ws.decisions.list("s") == ()
    finally:
        await ws.close()


class _AskRm(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Ask("sign-off") if ctx.command == "rm" else None


class _DenyRm(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Deny("no") if ctx.command == "rm" else None


class _Broken(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        raise RuntimeError("broken")


@pytest.mark.asyncio
async def test_explain_shows_every_policys_answer_in_chain_order():
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[_AskRm(), _DenyRm()],
    )
    try:
        said = await ws.explain("rm /data/x")
        [rm] = said.node.children
        assert isinstance(rm, CommandExplanation)
        # The Ask comes first and is still shown: no answer stops the
        # loop, and the Deny is what the line meets.
        assert rm.answers == (
            Ask("sign-off", policy="_AskRm"),
            Deny("no", policy="_DenyRm"),
        )
        # A policy's refusal is the command's: the line itself runs,
        # and exits as the refused command does.
        assert (rm.exit_code, rm.decision and rm.decision.reason) == (
            126,
            "no",
        )
        assert (said.outcome, said.reason, said.exit_code) == (
            Outcome.DENY,
            "no",
            126,
        )
        assert await Session(ws, None).explain.shell("rm /data/x") == said
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("whole_line", [False, True])
async def test_explanation_reports_answers_after_denial(
    whole_line, monkeypatch
):
    later: list[str] = []
    ask = _AskRm()
    original = ask.pre_command

    async def recorded(ctx):
        later.append(ctx.command)
        return await original(ctx)

    monkeypatch.setattr(ask, "pre_command", recorded)
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC if whole_line else MountMode.WRITE,
        policies=[_DenyRm(), ask],
        machines=[box] if whole_line else [],
    )
    try:
        line = "rm /data/x"
        [rm] = await _judged(ws, line)
        assert rm.answers == (
            Deny("no", policy="_DenyRm"),
            Ask("sign-off", policy="_AskRm"),
        )
        assert later == ["rm"]
        later.clear()
        ran = await ws.shell(line)
        assert ran.decision is not None and ran.decision.reason == "no"
        assert later == []
        assert box.lines == []
        assert not ws.decisions.pending()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("statement", "following"),
    [
        ("{ cd /data/d; cat inside; }", "/data/d/after"),
        ("(cd /data/d; cat inside)", "/after"),
        ("{ cd /data/d; cat inside; } &", "/after"),
        (": | { cd /data/d; cat inside; }", "/after"),
        ("echo $(cd /data/d; cat inside)", "/after"),
        ("echo <(cd /data/d; cat inside)", "/after"),
    ],
)
async def test_scope_of_a_cd_in_the_static_walk(statement, following):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        separator = " " if statement.endswith("&") else "; "
        said = await _judged(ws, f"{statement}{separator}cat after")
        assert [one.paths for one in said if one.command == "cat"] == [
            ("/data/d/inside",),
            (following,),
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_lastpipe_uses_the_live_shell_options():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert (
            await ws.shell("mkdir /data/d; shopt -s lastpipe")
        ).exit_code == 0
        line = ": | { cd /data/d; }; cat after"
        assert (await _judged(ws, line))[-1].paths == ("/data/d/after",)
        ran = await ws.shell(": | { cd /data/d; }; pwd")
        assert await ran.stdout_str() == "/data/d\n"
        ran = await ws.shell("cd /; set -m; : | { cd /data/d; }; pwd")
        assert await ran.stdout_str() == "/\n"
        assert (await _judged(ws, line))[-1].paths == ("/after",)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_later_and_forked_option_changes_leave_lastpipe_known():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert (await ws.shell("shopt -s lastpipe")).exit_code == 0
        for line in (
            ": | cd /data; cat ./file; shopt -u lastpipe",
            "(shopt -u lastpipe); : | cd /data; cat ./file",
            "echo $(shopt -u lastpipe); : | cd /data; cat ./file",
        ):
            [cat] = [
                item
                for item in await _judged(ws, line)
                if item.command == "cat"
            ]
            assert cat.paths == ("/data/file",)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "toggle",
    [
        "shopt -u lastpipe",
        "set -m",
        "set -o monitor",
        "command -- shopt -u lastpipe",
        'opt=shopt; "$opt" -u lastpipe',
        'opt=shopt; command -- "$opt" -u lastpipe',
    ],
)
async def test_same_line_option_changes_defer_relative_prepass_judgments(
    toggle,
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir /data/d; printf outer > /data/d/file")
        ws.create_session(
            "s",
            profile={
                "commands": {
                    "cat": [
                        "allow",
                        {
                            "decision": "deny",
                            "paths": ["/data/file"],
                            "reason": "sealed",
                        },
                    ],
                },
            },
        )
        await ws.shell("cd /data/d; shopt -s lastpipe", session_id="s")
        line = f"{toggle}; : | cd /data; cat ./file"
        said = await ws.explain(line, "s")
        ran = await ws.shell(line, session_id="s")
        assert (said.outcome, ran.exit_code) == (Outcome.ALLOW, 0)
        assert await ran.stdout_str() == "outer"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("definition", "outcome"),
    [
        (": | { sort() { :; }; };", Outcome.ALLOW),
        ("{ sort() { :; }; } | :;", Outcome.DENY),
        (": | { sort() { :; }; } &", Outcome.DENY),
    ],
)
async def test_explanation_follows_function_definitions_through_lastpipe(
    definition, outcome
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {"*": "deny", ":": "allow", "shopt": "allow"}
            },
        )
        assert (
            await ws.shell("shopt -s lastpipe", session_id="s")
        ).exit_code == 0
        line = f"{definition} sort /data/file"
        explained = await ws.explain(line, "s")
        ran = await ws.shell(line, session_id="s")
        assert explained.outcome is outcome
        assert explained.exit_code == ran.exit_code
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_background_pipeline_passes_lastpipe_to_its_child_stages():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("printf inner > /data/file; shopt -s lastpipe")
        line = ": | { : | cd /data; cat ./file; } & wait"
        [cat] = [
            item for item in await _judged(ws, line) if item.command == "cat"
        ]
        assert cat.paths == ("/data/file",)
        ran = await ws.shell(line)
        assert ran.exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sealed", [None, "/data/secret", "/data/public/secret"]
)
@pytest.mark.parametrize(
    "line",
    [
        "cd /data | cd /data/public; cat ./secret",
        ": | { : | cd /data/public; }; cat ./secret",
    ],
)
async def test_whole_line_lastpipe_checks_both_guest_cwds(sealed, line):
    box = _LineBox()
    cat = (
        "allow"
        if sealed is None
        else [
            "allow",
            {"decision": "deny", "paths": [sealed], "reason": "sealed"},
        ]
    )
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"r": {"commands": {"cat": cat, "cd": "allow"}}},
        machines=[box],
    )
    try:
        ws.create_session("s", profile="r")
        session = ws.get_session("s")
        session.cwd = "/data"
        for lastpipe, monitor in [(False, False), (True, False), (True, True)]:
            session.shopts["lastpipe"] = lastpipe
            session.shell_options["monitor"] = monitor
            explained = await ws.explain(line, "s")
            ran = await ws.shell(line, session_id="s")
            if sealed is None:
                assert (explained.outcome, ran.exit_code) == (Outcome.ALLOW, 0)
                assert ran.decision is None
            else:
                assert (explained.outcome, explained.reason) == (
                    Outcome.DENY,
                    "sealed",
                )
                assert (
                    ran.decision is not None
                    and ran.decision.reason == "sealed"
                )
        assert box.lines == ([line] * 3 if sealed is None else [])
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("same_line", [False, True])
async def test_a_function_can_change_lastpipe_before_the_next_pipeline(
    same_line,
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir /data/d; printf outer > /data/d/file")
        ws.create_session(
            "s",
            profile={
                "commands": {
                    "cat": [
                        "allow",
                        {
                            "decision": "deny",
                            "paths": ["/data/file"],
                            "reason": "sealed",
                        },
                    ],
                },
            },
        )
        await ws.shell("cd /data/d; shopt -s lastpipe", session_id="s")
        definition = "setoff() { shopt -u lastpipe; }"
        if not same_line:
            assert (await ws.shell(definition, session_id="s")).exit_code == 0
        line = "setoff; : | cd /data; cat ./file"
        if same_line:
            line = f"{definition}; {line}"
        [cat] = [
            item
            for item in await _judged(ws, line, "s")
            if item.command == "cat"
        ]
        assert "/data/file" not in cat.paths
        ran = await ws.shell(line, session_id="s")
        assert (ran.exit_code, await ran.stdout_str()) == (0, "outer")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_policy_that_fails_explains_as_a_deny():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[_Broken()]
    )
    try:
        said = await ws.explain("echo hi")
        ran = await ws.shell("echo hi")
        [echo] = said.node.children
        assert isinstance(echo, CommandExplanation)
        assert echo.decision is not None and ran.decision is not None
        assert (echo.outcome, echo.decision.kind) == (Outcome.DENY, "failed")
        assert (echo.exit_code, echo.stderr) == (
            ran.exit_code,
            await ran.stderr_str(),
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_reads_a_scope_that_spells_a_byte_past_utf8():
    # `env` runs printf as a scope of its own, spelled from the expanded
    # words, and `$'\xff'` expands to a byte no UTF-8 encodes.
    workspace = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        said = await workspace.explain("env printf '%d\\n' $'\\x27\\xff'")
        (env,) = said.node.children
        (scope,) = env.children
        (printf,) = scope.children
        assert (said.exit_code, printf.command) == (0, "printf")
        assert printf.words[-1].text == "'\udcff"
    finally:
        await workspace.close()


class _PythonOnC(Policy):
    def pre_command(self, ctx):
        return Route(machine="c") if ctx.command == "python3" else None


PATH_SPELLED = [
    "/usr/bin/python3 -c 1",
    "nice /usr/bin/python3 -c 1",
    "nohup /usr/bin/python3 -c 1",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line", PATH_SPELLED)
async def test_explain_refuses_a_usr_bin_path_as_its_program(line):
    # The run runs /usr/bin/python3 as python3, so a rule on the name
    # refuses the line in explain as it does when run.
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"m": {"provider": "in_process", "runtime": "monty"}},
        profiles={
            "default": {
                "commands": {"python3": {"decision": "deny", "reason": "no"}}
            }
        },
    )
    try:
        said = await ws.explain(line)
        ran = await ws.shell(line)
        assert (said.outcome, ran.exit_code) == (Outcome.DENY, 126)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", PATH_SPELLED)
async def test_explain_places_a_usr_bin_path_as_its_program(line):
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "m": {"provider": "in_process", "runtime": "monty"},
            "c": {
                "provider": "in_process",
                "runtime": "monty",
                "captures": ["python3"],
            },
        },
        policies=[_PythonOnC()],
    )
    try:
        said = await ws.explain(line)
        placed = [(c.command, c.machine) for c in _commands(said.node)]
        assert placed[-1] == ("python3", "c")
        assert all(machine == "" for _, machine in placed[:-1])
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["/data/l1 x", "nice /data/l1 x"])
async def test_a_link_loop_command_names_no_program(line):
    # A loop resolves to no file, so the run reports it and explain allows
    # the line, as for a path the /usr/bin view does not hold.
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC)
    try:
        await ws.shell("ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2")
        said = await ws.explain(line)
        ran = await ws.shell(line)
        assert (said.outcome, ran.exit_code) == (Outcome.ALLOW, 126)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_usr_bin_path_is_judged_past_a_function_of_its_name():
    # The path runs the program, never a function of the same name, so an
    # closed root holds over it on a line the box runs whole.
    box = _LineBox()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[box],
        route_policy=lambda ctx: "workspace" if "grep()" in ctx.line else None,
    )
    try:
        ws.create_session(
            "s", profile={"commands": {"*": "deny", "echo": "allow"}}
        )
        await ws.shell("grep() { echo hi; }", session_id="s")
        r = await ws.shell("/usr/bin/grep x /data", session_id="s")
        assert (r.exit_code, r.stderr) == (126, b"grep: Permission denied\n")
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_usr_bin_path_keeps_the_operands_xargs_appends_unread():
    box = _LineBox()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {
                    "echo": {
                        "operands": {
                            "forbidden": {"decision": "deny", "reason": "no"}
                        }
                    }
                }
            },
        )
        bare = await ws.shell("cat /data/f | xargs echo", session_id="s")
        r = await ws.shell("cat /data/f | xargs /usr/bin/echo", session_id="s")
        assert (r.exit_code, r.stderr) == (bare.exit_code, bare.stderr)
        assert bare.exit_code == 126
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_relative_path_after_a_cd_the_pass_lost_is_the_gate_s():
    # Read against the directory the pass last knew, ./python3 named the
    # /usr/bin program, which a closed tree refuses, and refused a harmless
    # script in /data.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"m": {"provider": "in_process", "runtime": "monty"}},
    )
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {
                    "*": "deny",
                    "cd": "allow",
                    "echo": "allow",
                    "printf": "allow",
                }
            },
        )
        await ws.shell(
            "printf 'echo harmless\\n' > /data/python3; cd /usr/bin",
            session_id="s",
        )
        r = await ws.shell('cd "$(echo /data)" && ./python3', session_id="s")
        assert (r.exit_code, r.stdout) == (0, b"harmless\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("operand", ["~/secret", "~agent/secret"])
async def test_a_tilde_names_the_users_home_when_the_line_is_judged(operand):
    # HOME is unset, so `~` is the user's home in the user database, as
    # the run expands it; the whole-line check reads the same path.
    agent = {
        "commands": {
            "*": "deny",
            "echo": "allow",
            "cat": [
                "allow",
                {
                    "decision": "deny",
                    "reason": "the secret is refused",
                    "paths": ["/home/agent/secret"],
                },
            ],
        },
    }
    ws = Workspace(
        {"/data/": RAMVFS(), "/home/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"agent": agent},
    )
    try:
        await ws.shell("mkdir -p /home/agent")
        await ws.vfs.write("/home/agent/secret", b"s\n")
        ws.create_session("a", profile="agent")
        ran = await ws.shell(
            f"echo changed > /data/marker; cat {operand}", session_id="a"
        )
        assert ran.exit_code == 1
        assert "/data/marker" not in await ws.vfs.readdir("/data")
    finally:
        await ws.close()


SUMMARY_SECRET = "/data/secret.txt"
SUMMARY_CLOSED = {"*": "deny", "ls": "allow"}
SUMMARY_SEALED = {
    "*": [
        "allow",
        {"decision": "deny", "reason": "sealed", "paths": [SUMMARY_SECRET]},
    ]
}
SUMMARY_NOD = {
    "*": [
        "allow",
        {"decision": "ask", "reason": "nod", "paths": [SUMMARY_SECRET]},
    ]
}

SUMMARIES = [
    (SUMMARY_CLOSED, "ls /data", Outcome.ALLOW, ""),
    (SUMMARY_CLOSED, "f() { ls /data; }; f", Outcome.ALLOW, ""),
    (
        SUMMARY_CLOSED,
        "sort /data/x; sort() { ls /data; }",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "(sort() { ls /data; }); sort /data/x",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "! ls /data && sort() { ls /data; }; sort /data/x",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "outer() { inner; }; inner() { ls /data; }; outer",
        Outcome.ALLOW,
        "",
    ),
    (
        SUMMARY_CLOSED,
        "x=$(sort() { ls /data; }); sort /data/x",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "sort() { ls /data; }; x=$(sort /data/x)",
        Outcome.ALLOW,
        "",
    ),
    (
        SUMMARY_CLOSED,
        "sort /data/x; ls /data &",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "case x in a|x) sort /data/x;; *) ls /data;; esac",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "case y in x) sort /data/x;; esac",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (SUMMARY_CLOSED, "sort /data/x", Outcome.DENY, "sort is not allowed"),
    (
        SUMMARY_CLOSED,
        "ls /data; sort /data/x",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "sort /data/x; ls /data",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (SUMMARY_CLOSED, "ls /data | sort", Outcome.DENY, "sort is not allowed"),
    (
        SUMMARY_CLOSED,
        "sort /data/x && ls /data",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "sort /data/x || ls /data",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (
        SUMMARY_CLOSED,
        "if ls /data; then sort /data/x; fi",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (SUMMARY_SEALED, "{ cat; } < /data/secret.txt", Outcome.DENY, "sealed"),
    (SUMMARY_SEALED, "> /data/secret.txt", Outcome.DENY, "sealed"),
    (SUMMARY_SEALED, "(cat) < /data/secret.txt", Outcome.DENY, "sealed"),
    (
        SUMMARY_SEALED,
        "while read l; do :; done < /data/secret.txt",
        Outcome.DENY,
        "sealed",
    ),
    (
        SUMMARY_SEALED,
        "if true; then cat; fi < /data/secret.txt",
        Outcome.DENY,
        "sealed",
    ),
    (SUMMARY_SEALED, "> /data/secret.txt; ls /data", Outcome.DENY, "sealed"),
    (SUMMARY_SEALED, "ls /data && > /data/secret.txt", Outcome.DENY, "sealed"),
    (SUMMARY_SEALED, "ls /data\n> /data/secret.txt", Outcome.DENY, "sealed"),
    (
        SUMMARY_SEALED,
        "{ cat; } < /data/secret.txt; > /data/secret.txt",
        Outcome.DENY,
        "sealed",
    ),
    (
        SUMMARY_CLOSED,
        "! sort /data/x | ls /data",
        Outcome.DENY,
        "sort is not allowed",
    ),
    (SUMMARY_SEALED, "cd /data && > secret.txt", Outcome.DENY, "sealed"),
    (
        SUMMARY_SEALED,
        "cd /data && { cat; } < secret.txt",
        Outcome.DENY,
        "sealed",
    ),
    (
        SUMMARY_SEALED,
        "cd /data/d; (cat) < ../secret.txt",
        Outcome.DENY,
        "sealed",
    ),
    (SUMMARY_SEALED, "exec 3< /data/secret.txt", Outcome.DENY, "sealed"),
    (SUMMARY_NOD, "{ cat; } < /data/secret.txt", Outcome.ASK, "nod"),
    (SUMMARY_NOD, "{ cat; } < /data/secret.txt; ls /data", Outcome.ASK, "nod"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("commands", "line", "outcome", "reason"), SUMMARIES)
async def test_the_summary_is_the_strictest_part_at_the_runs_exit(
    commands, line, outcome, reason
):
    # A command refused where it stands and a redirect no command owns
    # both fail while the rest of the line runs: the summary names the
    # strictest of them and exits as the run does, a `;` list with its
    # last command's status.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell(
            "mkdir -p /data/d && printf 'b\\na\\n' > /data/x"
            " && printf 's\\n' > /data/secret.txt"
        )
        ws.create_session("s", profile={"commands": commands})
        said = await ws.explain(line, "s")
        assert not ws.decisions.pending()
        ran = await ws.shell(line, session_id="s")
        assert (said.outcome, said.reason) == (outcome, reason)
        assert (said.exit_code, said.stderr) == (
            ran.exit_code,
            await ran.stderr_str(),
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "outer() { sort /data/x; }; outer; sort() { ls /data; }",
        "(sort() { ls /data; }); outer() { sort /data/x; }; outer",
        "outer() { inner /data/x; }; outer; inner() { ls /data; }",
        "outer() { sort /data/x; }; outer; sort() { ls /data; }; outer",
        "outer() { inner /data/x; }; outer; inner() { ls /data; }; outer",
        "(sort() { ls /data; }); ls $(sort /data/x)",
    ],
)
async def test_a_function_body_sees_the_functions_defined_when_it_runs(line):
    # The function a body or a substitution names is not in scope where
    # it runs (defined later, in a subshell, or only after an earlier
    # call), so that name is the tool the closed root refuses, as the run
    # says.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("printf 'b\\na\\n' > /data/x")
        ws.create_session("s", profile={"commands": SUMMARY_CLOSED})
        said = await ws.explain(line, "s")
        ran = await ws.shell(line, session_id="s")
        assert ran.decision is not None
        assert (said.outcome, said.reason) == (
            Outcome.DENY,
            ran.decision.reason,
        )
    finally:
        await ws.close()


PREJUDGED = [
    ("rm /m/x", False),
    ("echo a > /m/log", False),
    ("rm /m/x 2>&1", False),
    ("echo a; rm /m/x", True),
    ("echo a && rm /m/x", True),
    ("cat /m/x | rm /m/y", True),
    ("eval 'rm /m/x'", True),
    ("eval 'echo a > /m/log; rm /m/x'", True),
    ("sh -c 'rm /m/x'", True),
    ("sh -c 'echo a; rm /m/x'", True),
    ("env rm /m/x", True),
    ("command rm /m/x", True),
    ("X=1 rm /m/x", False),
    ("! rm /m/x", False),
    ("if true; then rm /m/x; fi", True),
    ("for i in 1 2; do rm /m/f$i; done", False),
    ("( echo a; rm /m/x )", True),
    ("{ echo a; rm /m/x; }", True),
    ("( rm /m/x )", False),
    ("{ rm /m/x; }", False),
    ("echo $(echo a; rm /m/x)", True),
    ("echo $(rm /m/x)", True),
    ("xargs rm", True),
    ("echo /m/x | xargs rm", True),
    ("find /m -name x -exec rm {} \\;", True),
    ("find /m -name x", False),
    ("twice", False),
    ("time rm /m/x", False),
    ("$CMD /m/x", False),
]


@pytest.mark.asyncio
async def test_may_prejudge_is_false_only_where_the_pass_judges_under_two():
    ws = Workspace({"/m": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("twice() { echo a > /m/log; rm /m/x; }")
        session = ws.get_session(ws.default_session_id)
        for line, two in PREJUDGED:
            ast = parse(line)
            may = may_prejudge(
                ast, session, ws._registry, ws._namespace, HandOff()
            )
            judged = await line_judgments(
                ast, session, ws._registry, ws._namespace, HandOff()
            )
            count = sum(len(explained) for _, explained in judged)
            assert (may, count >= 2) == (two, two), line
    finally:
        await ws.close()


DENY_RM = {"commands": {"rm": {"decision": "deny", "reason": "no rm"}}}


@pytest.mark.asyncio
async def test_a_one_command_line_is_refused_by_its_gate_alone(monkeypatch):
    evaluated: list[str] = []
    evaluate = Policies._evaluate

    async def counted(self, method, *args, **kwargs):
        evaluated.append(method)
        return await evaluate(self, method, *args, **kwargs)

    monkeypatch.setattr(Policies, "_evaluate", counted)
    vfs = RAMVFS()
    vfs._store.files["/x"] = b"x\n"
    ws = Workspace(
        {"/m": vfs},
        mode=MountMode.WRITE,
        profiles={"p": DENY_RM},
        profile="p",
    )
    try:
        held = await ws.shell("echo a > /m/log && rm /m/x")
        assert (held.exit_code, held.stderr) == (
            126,
            b"rm: Permission denied\n",
        )
        assert sorted(vfs._store.files) == ["/x"]
        evaluated.clear()
        ran = await ws.shell("rm /m/x")
        assert (ran.exit_code, ran.stderr) == (
            126,
            b"rm: Permission denied\n",
        )
        assert evaluated.count("pre_command") == 1
        assert sorted(vfs._store.files) == ["/x"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_loop_of_one_command_asks_at_each_gate():
    asked: list[str] = []
    vfs = RAMVFS()
    vfs._store.files["/f1"] = b"1\n"
    vfs._store.files["/f2"] = b"2\n"
    ws = Workspace(
        {"/m": vfs},
        mode=MountMode.WRITE,
        profiles={
            "p": {
                "commands": {"rm": {"decision": "ask", "reason": "confirm rm"}}
            }
        },
        profile="p",
        on_ask=_answering(asked, Outcome.ALLOW),
    )
    try:
        ran = await ws.shell("for i in 1 2; do rm /m/f$i; done")
        assert ran.exit_code == 0
        assert len(asked) == 2
        assert sorted(vfs._store.files) == []
    finally:
        await ws.close()
