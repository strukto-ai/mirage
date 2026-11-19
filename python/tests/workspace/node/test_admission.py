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

import dataclasses
import errno

import pytest

from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.io import IOResult
from mirage.machine.handle import MachineHandle
from mirage.policy import (
    Action,
    Decision,
    Deny,
    Outcome,
    Policy,
    PolicyDenied,
    Scope,
)
from mirage.policy.profile import PathsBlock, SessionProfile
from mirage.policy.types import CommandContext
from mirage.rs.policy import rule_table
from mirage.runtime.types import RunResult
from mirage.shell.parse import parse
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.node.admission import (
    Admitted,
    admit,
)
from mirage.workspace.node.explain import admit_line
from mirage.workspace.tools.io_text import with_decision
from tests.fixtures.command_trees import trees

DOC = {
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
        "rm": "allow",
        "ls": [
            "allow",
            {
                "decision": "deny",
                "reason": "private",
                "paths": ["/data/private"],
            },
        ],
        "ln": "allow",
        "echo": "allow",
        "head": "allow",
        "grep": [
            "allow",
            {
                "decision": "deny",
                "reason": "private",
                "paths": ["/data/private"],
            },
        ],
        "rg": [
            "allow",
            {
                "decision": "deny",
                "reason": "private",
                "paths": ["/data/private"],
            },
        ],
        "cd": "allow",
        "xargs": "allow",
        "sh": "allow",
        "mkdir": "allow",
        "eval": "allow",
        "source": "allow",
    }
}


def _ws() -> Workspace:
    return Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": DOC},
    )


def _voiced(refused) -> str:
    """stderr as bash prints it, then the record as one more line: what
    an agent reading through the text adapters sees."""
    return with_decision(refused.stderr.decode(), refused.decision)


@pytest.mark.asyncio
async def test_admit_line_refuses_the_first_offending_command():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        assert (
            await admit_line(
                parse("cat /data/a | head -n 1"), session, registry, namespace
            )
            is None
        )
        # An unlisted word anywhere in the line is the allow list's Deny.
        decision = await admit_line(
            parse("cat /data/a | sort"), session, registry, namespace
        )
        assert decision is not None
        assert (decision.exit_code, decision.stderr) == (
            126,
            b"sort: Permission denied\n",
        )
        # A rule reads the literal words, path-shaped ones as paths.
        decision = await admit_line(
            parse("ls /data && cat /data/secret"), session, registry, namespace
        )
        assert decision is not None
        assert (decision.exit_code, decision.stderr) == (
            1,
            b"cat: /data/secret: Permission denied\n",
        )
        # The same gate, one command at a time; a command that gets
        # through comes back as its gate.
        assert isinstance(
            await admit("rm", ["/data/x"], [], session, registry, namespace),
            Admitted,
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_bare_listing_reads_the_working_directory():
    # `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the cwd,
    # an operand the executor injects after the gate; a rule on that
    # directory has to see it here, as the operand typed `.`.
    ws = _ws()
    try:
        await ws.shell("mkdir -p /data/private && echo x > /data/private/f")
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def run(name: str, *args: str, stdin: bytes | None = None):
            words = await classify_parts([name, *args], registry, session.cwd)
            decision = await admit(
                name,
                list(args),
                words[1:],
                session,
                registry,
                namespace,
                stdin=stdin,
            )
            return (
                None
                if isinstance(decision, Admitted)
                else (decision.exit_code, _voiced(decision))
            )

        assert await run("ls") is None
        await ws.shell("cd /data/private")
        assert await run("ls") == (
            1,
            "ls: cannot access '.': Permission denied\npolicy denied: private\n",
        )
        # A named operand replaces the implied one.
        assert await run("ls", "/data") is None
        # grep reads the cwd only under -r; rg yields to a piped stdin.
        assert await run("grep", "x") is None
        assert await run("grep", "-r", "x") == (
            1,
            "grep: /data/private: Permission denied\npolicy denied: private\n",
        )
        assert await run("rg", "x", stdin=b"x\n") is None
        assert await run("rg", "x") == (
            1,
            "rg: /data/private: Permission denied\npolicy denied: private\n",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_reads_literal_words_and_refuses_the_unreadable():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def line(text: str):
            decision = await admit_line(
                parse(text), session, registry, namespace
            )
            return (
                None
                if decision is None
                else (decision.exit_code, _voiced(decision))
            )

        # Quotes and escapes read as the text they name: a quoted path
        # is a path, a quoted head is the command.
        assert await line("'cat' \"/data/secret\"") == (
            1,
            "cat: /data/secret: Permission denied\npolicy denied: sealed\n",
        )
        assert await line("cat /data/sec\\ret") == (
            1,
            "cat: /data/secret: Permission denied\npolicy denied: sealed\n",
        )
        # A head only the runtime can expand is refused under any rule.
        assert await line("$cmd /data/x") == (
            126,
            "$cmd: Permission denied\n"
            "policy denied: cannot read $cmd before the runtime "
            "expands it\n",
        )
        assert await line('"$cmd" /data/x') == (
            126,
            '"$cmd": Permission denied\n'
            'policy denied: cannot read "$cmd" before the runtime '
            "expands it\n",
        )
        # An argument is refused only where a rule reads that command's
        # arguments: cat has a path rule, echo has none.
        assert await line('cat "$f"') == (
            126,
            "cat: Permission denied\n"
            'policy denied: cannot read "$f" before the runtime '
            "expands it\n",
        )
        assert await line("cat /data/{a,secret}") == (
            126,
            "cat: Permission denied\n"
            "policy denied: cannot read /data/{a,secret} before the "
            "runtime expands it\n",
        )
        assert await line('echo "$HOME" $(ls /data)') is None
        # What a word runs is admitted in turn.
        assert await line("eval 'cat /data/secret'") == (
            1,
            "cat: /data/secret: Permission denied\npolicy denied: sealed\n",
        )
        assert await line('eval "$p"') == (
            126,
            '"$p": Permission denied\n'
            'policy denied: cannot read "$p" before the runtime '
            "expands it\n",
        )
        assert await line("echo $(cat /data/secret)") == (
            1,
            "cat: /data/secret: Permission denied\npolicy denied: sealed\n",
        )
        assert await line("ls | xargs cat") == (
            126,
            "cat: Permission denied\n"
            "policy denied: runs on operands the gate cannot read\n",
        )
        assert await line("ls | xargs echo") is None
        assert await line("source /data/env.sh") == (
            126,
            "source: Permission denied\n"
            "policy denied: runs lines the gate cannot read\n",
        )
        assert await line("/data/run.sh") == (
            126,
            "/data/run.sh: Permission denied\n"
            "policy denied: runs lines the gate cannot read\n",
        )
        assert await line("sh -c 'rm /data/x'; sh -c 'sort'") == (
            126,
            "sort: Permission denied\npolicy denied: sort is not allowed\n",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_classifies_bare_operands_with_the_spec():
    # `cat secret` from /data names /data/secret only through cat's
    # spec: the bare word has no path shape for the heuristics, and the
    # runtime resolves it against the cwd exactly as the spec hints do.
    ws = _ws()
    try:
        await ws.shell("cd /data")
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        decision = await admit_line(
            parse("cat secret"), session, registry, namespace
        )
        assert decision is not None
        assert (decision.exit_code, decision.stderr) == (
            1,
            b"cat: secret: Permission denied\n",
        )
        assert (
            await admit_line(parse("cat open"), session, registry, namespace)
            is None
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_reads_an_interpreters_script_as_a_path():
    # The runtime that takes the line runs the interpreter itself, where
    # no dispatcher follows the script read, so the gate types the script
    # slot from the interpreter's spec as it does a mount command's: a
    # bare name under the cwd is the file it names, and once -c or -e
    # names the program no operand is a path.
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "commands": {
                    "*": {
                        "decision": "deny",
                        "reason": "sealed",
                        "paths": ["/data/secret*"],
                    }
                }
            }
        },
    )
    try:
        await ws.shell("cd /data")
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        decision = await admit_line(
            parse("python3 secret.py"), session, registry, namespace
        )
        assert decision is not None
        assert (decision.exit_code, decision.stderr) == (
            1,
            b"python3: secret.py: Permission denied\n",
        )
        decision = await admit_line(
            parse("node -- secret.js"), session, registry, namespace
        )
        assert decision is not None
        assert (decision.exit_code, decision.stderr) == (
            1,
            b"node: secret.js: Permission denied\n",
        )
        for text in (
            "python3 -c 'print(1)' secret.py",
            "node -e 1 secret.js",
            "python3 open.py",
        ):
            assert (
                await admit_line(parse(text), session, registry, namespace)
                is None
            ), text
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_refuses_a_walk_or_a_glob_under_a_path_rule():
    # Every line executor acts outside the entry gate (a sandbox's own
    # disk), so a command a path rule reads must not reach it with a
    # walk or a pattern in hand: the walk would read entries the gate
    # never judged, and only the runtime would see the matches.
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def line(text: str):
            decision = await admit_line(
                parse(text), session, registry, namespace
            )
            return (
                None
                if decision is None
                else (decision.exit_code, _voiced(decision))
            )

        assert await line("grep -r x /data") == (
            126,
            "grep: Permission denied\n"
            "policy denied: walks a tree the gate cannot follow\n",
        )
        assert await line("rg x /data") == (
            126,
            "rg: Permission denied\n"
            "policy denied: walks a tree the gate cannot follow\n",
        )
        assert await line("cat /data/se*") == (
            126,
            "cat: Permission denied\n"
            "policy denied: expands a pattern only the runtime can "
            "read\n",
        )
        # The judged words still pass: a named clean path, a command no
        # path rule reads, a walker the rules leave alone.
        assert await line("grep x /data/open.txt") is None
        assert await line("echo /data/*") is None
        assert await line("head -n 1 /data/open.txt") is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_reads_redirect_targets_as_words_of_the_command():
    # The shell opens a redirect target on its own fds, outside the
    # admitted command's gate window, so the gate judges it with the
    # line: `cat < /data/secret` reads the file it protects, and a
    # target only the runtime can expand is unread like any word.
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def line(text: str):
            decision = await admit_line(
                parse(text), session, registry, namespace
            )
            return (
                None
                if decision is None
                else (decision.exit_code, _voiced(decision))
            )

        assert await line("cat < /data/secret") == (
            1,
            "cat: /data/secret: Permission denied\npolicy denied: sealed\n",
        )
        assert await line("head -c 1 /data/open > /data/secret2") is None
        assert await line("cat /data/open > /data/secret2") == (
            1,
            "cat: /data/secret2: Permission denied\npolicy denied: sealed\n",
        )
        assert await line("cat < $F") == (
            126,
            "cat: Permission denied\n"
            "policy denied: cannot read $F before the runtime "
            "expands it\n",
        )
        assert await line("echo hi > $F") is None
        assert await line("cat /data/open <<< 'body'") is None
    finally:
        await ws.close()


# The parse hoists a trailing redirect over whatever precedes it, a `!`
# included (`! cat < f` is redirected(negated(cat), < f)), and every
# shape still names the command bash opens the file for.
HOISTED = [
    "! cat < /data/secret",
    "echo a && ! cat < /data/secret",
    "! cat < /data/secret | cat",
    "echo x | cat < /data/secret",
    "echo a && echo x | cat < /data/secret",
    "echo a && cat < /data/secret | cat",
    "time cat < /data/secret",
    "! { time cat < /data/secret; }",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("text", HOISTED)
async def test_admit_line_binds_a_hoisted_redirect_to_its_command(text):
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        decision = await admit_line(
            parse(text), session, ws._registry, ws._namespace
        )
        assert decision is not None
        assert (decision.exit_code, _voiced(decision)) == (
            1,
            "cat: /data/secret: Permission denied\npolicy denied: sealed\n",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("text", HOISTED)
async def test_a_hoisted_redirect_is_judged_with_its_command_on_the_run(text):
    # The run hands a redirect's targets to the gate of the node it
    # runs under them, so a redirect left on a `!` (or a pipeline) never
    # reached `cat`'s gate and `! cat < /data/secret` printed the file.
    ws = _ws()
    try:
        await ws.shell("echo TOPSECRET > /data/secret")
        io = await ws.shell(text)
        assert "TOPSECRET" not in await io.stdout_str()
        assert "cat: /data/secret: Permission denied" in await io.stderr_str()
        assert io.decision is not None and io.decision.reason == "sealed"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_hidden_path_is_no_path_to_any_policy():
    # A session that cannot see a path must not learn of it from a
    # rule: the gate drops the operand before any method, the rule does
    # not fire, and the line goes on to the dispatcher, which answers ENOENT.
    ws = _ws()
    try:
        await ws.shell("mkdir -p /data/private && echo s > /data/secret")
        veiled = ws.create_session(
            "veiled",
            profile=SessionProfile(
                paths=PathsBlock(hide=("/data/secret", "/data/private"))
            ),
        )
        plain = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def run(session, name: str, *args: str):
            words = await classify_parts([name, *args], registry, session.cwd)
            decision = await admit(
                name, list(args), words[1:], session, registry, namespace
            )
            return (
                None
                if isinstance(decision, Admitted)
                else (decision.exit_code, _voiced(decision))
            )

        assert await run(plain, "cat", "/data/secret") == (
            1,
            "cat: /data/secret: Permission denied\npolicy denied: sealed\n",
        )
        assert await run(veiled, "cat", "/data/secret") is None
        assert await run(plain, "ls", "/data/private") == (
            1,
            "ls: cannot access '/data/private': Permission denied\n"
            "policy denied: private\n",
        )
        assert await run(veiled, "ls", "/data/private") is None
        # The followed target and the implied operand are dropped too.
        await ws.shell("ln -s /data/secret /data/l")
        assert await run(plain, "cat", "/data/l") == (
            1,
            "cat: /data/l: Permission denied\npolicy denied: sealed\n",
        )
        assert await run(veiled, "cat", "/data/l") is None
        # Whatever the session sees is still read as before.
        assert await run(veiled, "cat", "/data/a") is None
        await ws.shell("echo x > /data/private/f")
        assert await run(plain, "grep", "-r", "x", "/data/private") == (
            1,
            "grep: /data/private: Permission denied\npolicy denied: private\n",
        )
        assert await run(veiled, "grep", "-r", "x", "/data/private") is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_without_rules_admits_the_words_as_typed():
    # No command rule in force: nothing is refused for being unreadable,
    # which is what a coded policy always saw.
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        for text in (
            "$cmd /data/x",
            'eval "$p"',
            "source /data/env.sh",
            "ls | xargs cat",
        ):
            assert (
                await admit_line(
                    parse(text), session, ws._registry, ws._namespace
                )
                is None
            )
    finally:
        await ws.close()


def _gate_ctx(tokens: tuple[str, ...]) -> CommandContext:
    return CommandContext(
        command=tokens[0],
        paths=(),
        argv=tokens[1:],
        cwd="/",
        tokens=tokens,
    )


def test_the_admitted_gate_judges_what_the_line_did_not_name():
    rules = trees(
        {
            "grep": [
                {
                    "decision": "deny",
                    "reason": "sealed",
                    "paths": ["/data/sealed"],
                },
                {
                    "decision": "ask",
                    "reason": "nod",
                    "paths": ["/data/asked/*"],
                },
            ]
        }
    )
    (ask,) = (r for r in rule_table(rules) if r.reason == "nod")
    gate = Admitted(
        rules=rules,
        ctx=_gate_ctx(("grep", "-r", "x", "/data")),
        judged=frozenset({"/data"}),
        granted=(),
    )
    gate.check("/data")
    gate.check("/data/open/o")
    with pytest.raises(PolicyDenied) as info:
        gate.check("/data/sealed/s")
    assert info.value.errno == errno.EACCES
    assert info.value.strerror == "Permission denied"
    assert info.value.decision and info.value.decision.reason == "sealed"
    assert info.value.filename == "/data/sealed/s"
    with pytest.raises(PolicyDenied) as info:
        gate.check("/data/asked/a")
    assert info.value.strerror == "Permission denied"
    assert info.value.decision and info.value.decision.reason == "nod"
    # An operand the gate judged passes whatever the rules say about it
    # (the line was admitted on it), and a grant under the asking rule
    # opens its scope to the walk.
    judged = Admitted(
        rules=rules,
        ctx=_gate_ctx(("grep", "x", "/data/asked/a")),
        judged=frozenset({"/data/asked/a"}),
        granted=(),
    )
    judged.check("/data/asked/a")
    granted = Admitted(
        rules=rules,
        ctx=_gate_ctx(("grep", "-r", "x", "/data/asked")),
        judged=frozenset({"/data/asked"}),
        granted=(ask,),
    )
    granted.check("/data/asked/a")


def test_the_admitted_gate_scopes_each_start_point_on_its_own():
    # A walk keeps its native op where no rule could reach: the gate of
    # `find /data /other` sets aside only the walk of /data.
    rules = trees(
        {
            "*": {
                "decision": "deny",
                "reason": "sealed",
                "paths": ["/data/sealed"],
            }
        }
    )
    gate = Admitted(
        rules=rules,
        ctx=_gate_ctx(("find", "/data", "/other")),
        judged=frozenset({"/data", "/other"}),
        granted=(),
    )
    assert gate.scopes("/data")
    assert gate.scopes("/data/sealed/s")
    assert not gate.scopes("/other")


@pytest.mark.asyncio
async def test_admit_reports_the_grant_the_line_runs_under():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        words = await classify_parts(["rm", "/data/x"], registry, session.cwd)
        verdict = await admit(
            "rm", ["/data/x"], words[1:], session, registry, namespace
        )
        assert isinstance(verdict, Admitted)
        assert verdict.ctx.tokens == ("rm", "/data/x")
        assert verdict.judged == frozenset({"/data/x"})
        assert verdict.granted == ()
    finally:
        await ws.close()


# ── what the handler a command resolves to declares ──────────────


async def _noop(accessor, paths, texts, ctx):
    return None, IOResult()


# --token is filled from the session's env; the gate's walk must read it too.
ISSUES = CLI(
    spec=CommandSpec(
        name="issues",
        arguments=(Argument("--token", env="TOKEN", required=True),),
        subcommands=(
            CommandSpec(name="list"),
            CommandSpec(name="create", aliases=("new",)),
        ),
    ),
    handlers={
        "list": CLIHandler(fn=_noop),
        "create": CLIHandler(fn=_noop, write=True),
    },
)
# A tree a mount serves; the gate reads its group path, a leaf path the
# env fills and a leaf's file, behind the env-filled --token, as the walk does.
NOTES = CLI(
    spec=CommandSpec(
        name="notes",
        arguments=(
            Argument("--file", type="path"),
            Argument("--token", env="TOKEN", required=True),
        ),
        subcommands=(
            CommandSpec(
                name="show",
                arguments=(
                    Argument("-C", type="path"),
                    Argument("paths", type="path", nargs="*"),
                ),
                operand_base="-C",
            ),
            CommandSpec(
                name="add",
                arguments=(Argument("--out", type="path", env="OUT"),),
            ),
        ),
    ),
    handlers={
        "show": CLIHandler(fn=_noop),
        "add": CLIHandler(fn=_noop, write=True),
    },
)
# A flat tree: -e from the env takes the text slot, so the word is a file.
SCAN = CLI(
    spec=CommandSpec(
        name="scan",
        arguments=(
            Argument("-e", env="PATTERN"),
            Argument("text", nargs="?", provided_by=("-e",)),
            Argument("paths", type="path", nargs="*"),
        ),
    ),
    handlers={"": CLIHandler(fn=_noop)},
)
PATHS = CommandSpec(arguments=(Argument("paths", type="path", nargs="*"),))
COMMANDS = [
    command("peek", vfs=None, spec=CommandSpec())(_noop),
    command("stamp", vfs=None, spec=CommandSpec(), write=True)(_noop),
    command("show", vfs=None, spec=PATHS)(_noop),
    command("show", vfs=None, spec=PATHS, filetype=".csv", write=True)(_noop),
]


class NoWrites(Policy):
    def __init__(self) -> None:
        self.seen: dict[str, bool] = {}
        self.programs: dict[str, tuple[str, ...]] = {}
        self.paths: dict[str, list[str]] = {}

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        self.seen[ctx.line] = ctx.write
        self.programs[ctx.line] = tuple(ctx.program)
        self.paths[ctx.line] = [p.virtual for p in ctx.paths]
        return Deny("this session only reads") if ctx.write else None


@pytest.mark.asyncio
async def test_fallback_admission_reads_each_candidate_leaf():
    policy = NoWrites()
    ws = Workspace(
        {"/longer": RAMVFS(), "/b": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[policy],
    )
    ws.mount("/longer").register_commands(
        [
            command(
                "tool",
                vfs=None,
                spec=CommandSpec(arguments=(Argument("args", nargs="*"),)),
            )(_noop),
        ]
    )
    ws.mount("/b").register_commands(
        [
            CLI(
                spec=CommandSpec(
                    name="tool",
                    subcommands=(
                        CommandSpec(name="peek"),
                        CommandSpec(name="send"),
                    ),
                ),
                handlers={
                    "peek": CLIHandler(_noop),
                    "send": CLIHandler(_noop, write=True),
                },
            ),
        ]
    )
    try:
        read = await ws.shell("tool peek")
        assert read.exit_code == 0
        write = await ws.shell("tool send")
        assert write.exit_code == 126
        assert policy.seen == {"tool peek": False, "tool send": True}
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["deny", "ask"])
async def test_fallback_tree_policy_matches_the_verb_after_group_options(
    decision,
):
    calls = []

    @command(
        "remote",
        vfs=None,
        spec=CommandSpec(arguments=(Argument("args", nargs="*"),)),
    )
    async def reader(accessor, paths, texts, ctx):
        calls.append("reader")
        return None, IOResult()

    async def writer(accessor, paths, texts, ctx):
        calls.append("writer")
        return None, IOResult()

    ws = Workspace(
        {"/reader": RAMVFS(), "/write": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"remote": {"send": decision}}}},
    )
    try:
        ws.mount("/reader").register_commands([reader])
        ws.mount("/write").register_commands(
            [
                CLI(
                    spec=CommandSpec(
                        name="remote",
                        arguments=(Argument("--account"),),
                        subcommands=(
                            CommandSpec(name="send", aliases=("deliver",)),
                        ),
                    ),
                    handlers={"send": CLIHandler(writer, write=True)},
                )
            ]
        )
        result = await ws.shell("remote --account team deliver")
        assert result.exit_code != 0
        assert result.decision is not None
        assert calls == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_fallback_read_ignores_an_unselectable_read_only_writer():
    policy = NoWrites()
    calls = []

    @command("remote", vfs=None, spec=CommandSpec())
    async def reader(accessor, paths, texts, ctx):
        calls.append("reader")
        return b"reader\n", IOResult()

    @command("remote", vfs=None, spec=CommandSpec(), write=True)
    async def writer(accessor, paths, texts, ctx):
        calls.append("writer")
        return None, IOResult()

    ws = Workspace(
        {
            "/reader": RAMVFS(),
            "/write": (RAMVFS(), MountMode.READ),
        },
        mode=MountMode.WRITE,
        policies=[policy],
    )
    try:
        ws.mount("/reader").register_commands([reader])
        ws.mount("/write").register_commands([writer])
        result = await ws.shell("remote")
        assert (result.exit_code, result.stdout, result.stderr or b"") == (
            0,
            b"reader\n",
            b"",
        )
        assert policy.seen == {"remote": False}
        assert calls == ["reader"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_command_reads_as_writing_when_its_handler_says_so():
    policy = NoWrites()
    ws = Workspace(
        {"/data/": RAMVFS(), "/other/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[policy],
    )
    ws.register_cli("issues", ISSUES)
    ws.mount("/data/").register_commands(COMMANDS)
    ws.mount("/data/").register_commands([NOTES, SCAN])
    # /other/'s diff writes, and an attached path option routes there.
    ws.mount("/other/").register_commands(
        [
            command("show", vfs=None, spec=PATHS, write=True)(_noop),
            command("diff", vfs=None, spec=SPECS["diff"], write=True)(_noop),
        ]
    )
    lines = {
        "issues list": False,
        "issues create": True,
        "issues new": True,
        "issues nope": False,
        "notes show": False,
        "notes add": True,
        "notes --file /other/secret show": False,
        "notes show /other/note": False,
        "notes show -C /other note": False,
        "scan /other/s": False,
        "peek": False,
        "stamp": True,
        "show /data/a.txt": False,
        "show /data/a.csv": True,
        "show /data/a.txt /other/b.txt": True,
        "show /data/l.txt": True,
        "diff --exclude-from=/other/list - -": True,
        "cat /data/a.txt": False,
        "rm -f /data/a.txt": True,
        "sort -o /data/b.txt /data/a.txt": True,
        # A builtin that writes only under an option reads as a reader
        # without it.
        "sort /data/a.txt": False,
        "sed -n p /data/a.txt": False,
        "sed -i s/a/b/ /data/a.txt": True,
        "tar -tf /data/a.tar": False,
        "uniq /data/a.txt /data/u.txt": True,
        # A pattern may expand to an output file too; a quoted name is no
        # pattern.
        "uniq /data/a.*": True,
        "uniq '/data/a[1].txt'": False,
        "chmod 644 /data/a.txt": True,
        "ln -s /data/a.txt /data/l": True,
        "echo hi": False,
    }
    try:
        await ws.shell("export TOKEN=t OUT=/other/out PATTERN=p")
        # A run follows the link to the .csv, whose `show` writes.
        await ws.vfs.write("/data/f.csv", b"x\n")
        await ws.vfs.symlink("/data/l.txt", "/data/f.csv")
        for line in lines:
            await ws.shell(line)
    finally:
        await ws.close()
    assert policy.seen == lines
    assert policy.programs["issues new"] == ("issues", "create")
    assert policy.paths["notes --file /other/secret show"] == ["/other/secret"]
    assert policy.paths["notes add"] == ["/other/out"]
    assert policy.paths["notes show /other/note"] == ["/other/note"]
    assert policy.paths["scan /other/s"] == ["/other/s"]
    assert policy.paths["notes show -C /other note"] == [
        "/other",
        "/other/note",
    ]


# `[ ]` and `[[ ]]` are the shell's own tests, which no command gate
# sees, so each is admitted by its own name on what it tests, as `test`
# is: a path rule reads a file operand however it is spelled, and an
# allow list answers each name for itself.
DENY_SECRET = {
    "commands": {
        "*": {
            "decision": "deny",
            "reason": "secret",
            "paths": ["/data/secret.txt"],
        }
    }
}


def _spell(name: str, expr: str) -> str:
    if name == "test":
        return f"test {expr}"
    return f"{name} {expr} {']' if name == '[' else ']]'}"


async def _tested(profile: dict, line: str) -> tuple[int, str, str]:
    ws = _ws()
    await ws.shell("echo a > /data/a.txt; echo s > /data/secret.txt")
    ws.create_session("s", profile=profile)
    r = await ws.shell(f"{line}; echo $?", session_id="s")
    return r.exit_code, r.stdout.decode(), (r.stderr or b"").decode()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["test", "[", "[["])
async def test_a_shell_test_reads_a_file_operand_as_a_path_rule_does(name):
    for prefix, expr, path in (
        ("cd /data && ", "-e secret.txt", "secret.txt"),
        ("", "-e /data/secret.txt", "/data/secret.txt"),
        ("cd /data && ", "a.txt -nt secret.txt", "secret.txt"),
    ):
        assert await _tested(DENY_SECRET, prefix + _spell(name, expr)) == (
            1,
            "",
            f"{name}: {path}: Permission denied\n",
        )
    line = "cd /data && " + _spell(name, "-e a.txt")
    assert await _tested(DENY_SECRET, line) == (0, "0\n", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["test", "["])
async def test_a_file_operator_on_the_left_compares_as_a_string(name):
    line = "cd /data && " + _spell(name, "-e = secret.txt")
    assert await _tested(DENY_SECRET, line) == (0, "1\n", "")


@pytest.mark.asyncio
async def test_double_brackets_admit_each_leaf():
    # The line's reader sees every literal leaf, so a ruled one holds
    # the line as `test -e a -o -e b` would.
    for expr in ("-e a.txt || -e secret.txt", "-e nope || -e secret.txt"):
        line = "cd /data && " + _spell("[[", expr)
        assert await _tested(DENY_SECRET, line) == (
            1,
            "",
            "[[: secret.txt: Permission denied\n",
        )
    # A leaf only the run can expand is admitted where it is reached,
    # and a branch never reached is never admitted.
    reached = "cd /data && x=secret.txt && [[ -e nope || -e $x ]]"
    assert await _tested(DENY_SECRET, reached) == (
        0,
        "1\n",
        "[[: secret.txt: Permission denied\n",
    )
    skipped = "cd /data && x=secret.txt && [[ -e a.txt || -e $x ]]"
    assert await _tested(DENY_SECRET, skipped) == (0, "0\n", "")


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["test", "[", "[["])
async def test_a_shell_test_is_answered_by_its_own_name_in_an_allow_list(
    name,
):
    line = "cd /data && " + _spell(name, "-e a.txt")
    without = {"commands": {"*": "deny", "echo": "allow", "cd": "allow"}}
    assert await _tested(without, line) == (
        0,
        "126\n",
        f"{name}: Permission denied\n",
    )
    listed = {
        "commands": {
            "*": "deny",
            "echo": "allow",
            "cd": "allow",
            name: "allow",
        }
    }
    assert await _tested(listed, line) == (0, "0\n", "")


SEALED = {
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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "{ cat; } < /data/secret.txt",
        'while read -r l; do echo "$l"; done < /data/secret.txt',
        "(cat) < /data/secret.txt",
        "if true; then cat; fi < /data/secret.txt",
        "> /data/secret.txt",
        "x=1 > /data/secret.txt",
        "exec > /data/secret.txt",
        "{ cat; } < /data/link",
    ],
)
async def test_a_redirect_no_command_owns_meets_the_root_path_leaf(line):
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"sealed": SEALED},
    )
    try:
        await ws.shell(
            "echo top > /data/secret.txt; ln -s /data/secret.txt /data/link"
        )
        ws.create_session("s", profile="sealed")
        io = await ws.shell(line, session_id="s")
        named = "/data/link" if "link" in line else "/data/secret.txt"
        assert (io.exit_code, await io.materialize_stdout()) == (1, b"")
        assert await io.materialize_stderr() == (
            f"bash: line 1: {named}: Permission denied\n".encode()
        )
        assert io.decision is not None
        assert (io.decision.kind, io.decision.reason) == ("deny", "sealed")
        kept = await ws.shell("cat /data/secret.txt")
        assert await kept.materialize_stdout() == b"top\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_redirect_no_command_owns_meets_no_leaf_about_commands():
    closed = {"commands": {"*": "deny", "ls": "allow", "cat": "allow"}}
    named = {
        "commands": {
            "cat": {"decision": "deny", "paths": ["/data/secret.txt"]}
        }
    }
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"closed": closed, "named": named},
    )
    try:
        await ws.shell("echo top > /data/secret.txt")
        ws.create_session("closed", profile="closed")
        ws.create_session("named", profile="named")
        io = await ws.shell("{ ls /data; } > /data/out", session_id="closed")
        assert io.exit_code == 0
        io = await ws.shell("{ cat; } < /data/secret.txt", session_id="named")
        assert (io.exit_code, await io.materialize_stdout()) == (0, b"top\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "stats"),
    [
        ("{ cat; } < /data/a/f", []),
        ("if true; then cat; fi < /data/a/f", []),
        ("cat < /data/a/f", ["/data/a/f"]),
    ],
)
async def test_only_a_command_redirect_stats_its_input(line, stats):
    vfs = RAMVFS()
    seen = []
    stat = vfs.stat

    async def counted(path, *args, **kwargs):
        seen.append(path.virtual)
        return await stat(path, *args, **kwargs)

    ws = Workspace(
        {"/data/": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"sealed": SEALED},
    )
    try:
        await ws.shell("mkdir /data/a; echo top > /data/a/f")
        ws.create_session("s", profile="sealed")
        vfs.stat = counted
        io = await ws.shell(line, session_id="s")
        assert (io.exit_code, await io.materialize_stdout()) == (0, b"top\n")
        assert seen == stats
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_judges_a_redirect_no_command_owns():
    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": SEALED},
    )
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        for line in (
            "{ cat; } < /data/secret.txt",
            "> /data/secret.txt",
            "exec 3< /data/secret.txt",
            "exec > /data/secret.txt",
            "echo a; exec 3< /data/secret.txt",
        ):
            refused = await admit_line(
                parse(line), session, registry, namespace
            )
            assert refused is not None
            assert refused.exit_code == 1
            assert refused.stderr.endswith(
                b": /data/secret.txt: Permission denied\n"
            )
        for line in (
            "{ cat; } < /data/other",
            "cat < /data/other",
            "exec 3< /data/other",
            "exec 3>&1",
        ):
            assert (
                await admit_line(parse(line), session, registry, namespace)
                is None
            )
    finally:
        await ws.close()


ASKS = {
    "commands": {
        "*": [
            "allow",
            {"decision": "ask", "reason": "nod", "paths": ["/data/f"]},
        ]
    }
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "{ cat; } < /data/f; > /data/f",
        "{ cat; } < /data/f > /data/f",
        "eval '> /data/f'; eval '> /data/f'",
        "sh -c '> /data/f'; sh -c '> /data/f'",
        ": $(> /data/f) $(> /data/f)",
        "for i in 1 2; do > /data/f; done; > /data/f",
    ],
)
async def test_each_redirect_no_command_owns_needs_a_nod_of_its_own(line):
    asked: list[str] = []

    async def allows_once(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(
            record, outcome=Outcome.ALLOW, scope=Scope.ONCE
        )

    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"asks": ASKS},
        on_ask=allows_once,
    )
    try:
        await ws.shell("echo top > /data/f")
        ws.create_session("s", profile="asks")
        io = await ws.shell(line, session_id="s")
        assert io.exit_code == 0
        assert len(asked) == 2
        kept = await ws.shell("cat /data/f")
        assert await kept.materialize_stdout() == b""
    finally:
        await ws.close()


class _LineBox(MachineHandle):
    provider = "box"

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        await output(b"ran\n")
        return RunResult(exit_code=0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["{ cat; } < /data/f; > /data/f", "{ cat; } < /data/f > /data/f"],
)
async def test_a_line_run_whole_asks_each_redirect_no_command_owns(line):
    asked: list[str] = []

    async def allows_once(record: Decision) -> Decision:
        asked.append(record.id)
        return dataclasses.replace(
            record, outcome=Outcome.ALLOW, scope=Scope.ONCE
        )

    ws = Workspace(
        {"/data/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.EXEC,
        machines={"box": _LineBox("box", {"captures": ["@line"]})},
        profiles={"asks": ASKS},
        on_ask=allows_once,
    )
    try:
        ws.create_session("s", profile="asks")
        io = await ws.shell(line, session_id="s")
        assert io.exit_code == 0
        assert await io.materialize_stdout() == b"ran\n"
        assert len(asked) == 2
    finally:
        await ws.close()
