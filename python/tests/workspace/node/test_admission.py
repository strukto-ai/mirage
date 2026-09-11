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

import errno

import pytest

from mirage.agents.io_text import with_refusal
from mirage.policy import PolicyDenied
from mirage.policy.profile import PathsBlock, SessionProfile
from mirage.policy.types import AdmissionRules, CommandRule
from mirage.resource.ram import RAMResource
from mirage.shell import parse
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.node.admission import (Admitted, admit, admit_line,
                                             policy_scopes)

DOC = {
    "commands": {
        "allow": [
            "cat", "rm", "ls", "ln", "echo", "head", "grep", "rg", "cd",
            "xargs", "sh", "mkdir", "eval", "source"
        ],
        "deny": [{
            "reason": "sealed",
            "commands": {
                "cat": ["/data/secret*"]
            }
        }, {
            "reason": "private",
            "commands": {
                "ls": ["/data/private"],
                "grep": ["/data/private"],
                "rg": ["/data/private"]
            }
        }],
    }
}


def _ws() -> Workspace:
    return Workspace({"/data/": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE,
                     profiles={"default": DOC})


def _virtuals(ws: Workspace, name: str, *args: str) -> list[str]:
    words = classify_parts([name, *args], ws._registry, "/")
    return [
        p.virtual
        for p in policy_scopes(name, list(args), words[1:], ws._namespace, "/")
    ]


def _voiced(refused) -> str:
    """stderr as bash prints it, then the record as one more line: what
    an agent reading through the text adapters sees."""
    return with_refusal(refused.stderr.decode(), refused.refusal)


@pytest.mark.asyncio
async def test_policy_scopes_follow_links_only_for_a_following_command():
    ws = _ws()
    try:
        await ws.execute("echo top > /data/secret && "
                         "ln -s /data/secret /data/link")
        # cat opens the target: the typed path first, then what it
        # resolves to; rm and `ls -l` act on the link itself.
        assert _virtuals(ws, "cat",
                         "/data/link") == ["/data/link", "/data/secret"]
        assert _virtuals(ws, "rm", "/data/link") == ["/data/link"]
        assert _virtuals(ws, "ls", "-l", "/data/link") == ["/data/link"]
        assert _virtuals(ws, "ls",
                         "/data/link") == ["/data/link", "/data/secret"]
        # A path that is not a link reads once; no namespace reads typed.
        assert _virtuals(ws, "cat", "/data/secret") == ["/data/secret"]
        words = classify_parts(["cat", "/data/link"], ws._registry, "/")
        assert [
            p.virtual
            for p in policy_scopes("cat", ["/data/link"], words[1:], None, "/")
        ] == ["/data/link"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_refuses_the_first_offending_command():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        assert await admit_line(parse("cat /data/a | head -n 1"), session,
                                registry, namespace) is None
        # An unlisted word anywhere in the line is 127 before any hook.
        refusal = await admit_line(parse("cat /data/a | sort"), session,
                                   registry, namespace)
        assert refusal is not None
        assert (refusal.exit_code,
                refusal.stderr) == (127, b"sort: command not found\n")
        # A rule reads the literal words, path-shaped ones as paths.
        refusal = await admit_line(parse("ls /data && cat /data/secret"),
                                   session, registry, namespace)
        assert refusal is not None
        assert (refusal.exit_code,
                refusal.stderr) == (1, b"cat: /data/secret: sealed\n")
        # The same gate, one command at a time; a command that gets
        # through comes back as its gate.
        assert isinstance(
            await admit("rm", ["/data/x"], [], session, registry, namespace),
            Admitted)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_bare_listing_reads_the_working_directory():
    # `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the cwd,
    # an operand the executor injects after the gate; a rule on that
    # directory has to see it here, as the operand typed `.`.
    ws = _ws()
    try:
        await ws.execute("mkdir -p /data/private && echo x > /data/private/f")
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def run(name: str, *args: str, stdin: bytes | None = None):
            words = classify_parts([name, *args], registry, session.cwd)
            refusal = await admit(name,
                                  list(args),
                                  words[1:],
                                  session,
                                  registry,
                                  namespace,
                                  stdin=stdin)
            return None if isinstance(
                refusal, Admitted) else (refusal.exit_code, _voiced(refusal))

        assert await run("ls") is None
        await ws.execute("cd /data/private")
        assert await run("ls") == (1, "ls: .: private\n")
        # A named operand replaces the implied one.
        assert await run("ls", "/data") is None
        # grep reads the cwd only under -r; rg yields to a piped stdin.
        assert await run("grep", "x") is None
        assert await run("grep", "-r",
                         "x") == (1, "grep: /data/private: private\n")
        assert await run("rg", "x", stdin=b"x\n") is None
        assert await run("rg", "x") == (1, "rg: /data/private: private\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_reads_literal_words_and_refuses_the_unreadable():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def line(text: str):
            refusal = await admit_line(parse(text), session, registry,
                                       namespace)
            return None if refusal is None else (refusal.exit_code,
                                                 _voiced(refusal))

        # Quotes and escapes read as the text they name: a quoted path
        # is a path, a quoted head is the command.
        assert await line("'cat' \"/data/secret\"") == (
            1, "cat: /data/secret: sealed\n")
        assert await line("cat /data/sec\\ret") == (
            1, "cat: /data/secret: sealed\n")
        # A head only the runtime can expand is refused under any rule.
        assert await line("$cmd /data/x") == (
            126, "$cmd: Permission denied\n"
            "policy denied: cannot read $cmd before the runtime "
            "expands it\n")
        assert await line('"$cmd" /data/x') == (
            126, '"$cmd": Permission denied\n'
            'policy denied: cannot read "$cmd" before the runtime '
            "expands it\n")
        # An argument is refused only where a rule reads that command's
        # arguments: cat has a path rule, echo has none.
        assert await line('cat "$f"') == (
            126, 'cat: Permission denied\n'
            'policy denied: cannot read "$f" before the runtime '
            "expands it\n")
        assert await line("cat /data/{a,secret}") == (
            126, "cat: Permission denied\n"
            "policy denied: cannot read /data/{a,secret} before the "
            "runtime expands it\n")
        assert await line('echo "$HOME" $(ls /data)') is None
        # What a word runs is admitted in turn.
        assert await line("eval 'cat /data/secret'") == (
            1, "cat: /data/secret: sealed\n")
        assert await line('eval "$p"') == (
            126, '"$p": Permission denied\n'
            'policy denied: cannot read "$p" before the runtime '
            "expands it\n")
        assert await line("echo $(cat /data/secret)") == (
            1, "cat: /data/secret: sealed\n")
        assert await line("ls | xargs cat") == (
            126, "cat: Permission denied\n"
            "policy denied: runs on operands the gate cannot read\n")
        assert await line("ls | xargs echo") is None
        assert await line("source /data/env.sh") == (
            126, "source: Permission denied\n"
            "policy denied: runs lines the gate cannot read\n")
        assert await line("/data/run.sh") == (
            126, "/data/run.sh: Permission denied\n"
            "policy denied: runs lines the gate cannot read\n")
        assert await line("sh -c 'rm /data/x'; sh -c 'sort'") == (
            127, "sort: command not found\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_classifies_bare_operands_with_the_spec():
    # `cat secret` from /data names /data/secret only through cat's
    # spec: the bare word has no path shape for the heuristics, and the
    # runtime resolves it against the cwd exactly as the spec hints do.
    ws = _ws()
    try:
        await ws.execute("cd /data")
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        refusal = await admit_line(parse("cat secret"), session, registry,
                                   namespace)
        assert refusal is not None
        assert (refusal.exit_code,
                refusal.stderr) == (1, b"cat: secret: sealed\n")
        assert await admit_line(parse("cat open"), session, registry,
                                namespace) is None
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
            refusal = await admit_line(parse(text), session, registry,
                                       namespace)
            return None if refusal is None else (refusal.exit_code,
                                                 _voiced(refusal))

        assert await line("grep -r x /data") == (
            126, "grep: Permission denied\n"
            "policy denied: walks a tree the gate cannot follow\n")
        assert await line("rg x /data") == (
            126, "rg: Permission denied\n"
            "policy denied: walks a tree the gate cannot follow\n")
        assert await line("cat /data/se*") == (
            126, "cat: Permission denied\n"
            "policy denied: expands a pattern only the runtime can "
            "read\n")
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
            refusal = await admit_line(parse(text), session, registry,
                                       namespace)
            return None if refusal is None else (refusal.exit_code,
                                                 _voiced(refusal))

        assert await line("cat < /data/secret") == (
            1, "cat: /data/secret: sealed\n")
        assert await line("head -c 1 /data/open > /data/secret2") is None
        assert await line("cat /data/open > /data/secret2") == (
            1, "cat: /data/secret2: sealed\n")
        assert await line("cat < $F") == (
            126, 'cat: Permission denied\n'
            'policy denied: cannot read $F before the runtime '
            "expands it\n")
        assert await line("echo hi > $F") is None
        assert await line("cat /data/open <<< 'body'") is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_hidden_path_is_no_path_to_any_policy():
    # A session that cannot see a path must not learn of it from a
    # rule: the gate drops the operand before any hook, the rule does
    # not fire, and the line goes on to the door, which answers ENOENT.
    ws = _ws()
    try:
        await ws.execute("mkdir -p /data/private && echo s > /data/secret")
        veiled = ws.create_session(
            "veiled",
            profile=SessionProfile(paths=PathsBlock(hide=("/data/secret",
                                                          "/data/private"))))
        plain = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace

        async def run(session, name: str, *args: str):
            words = classify_parts([name, *args], registry, session.cwd)
            refusal = await admit(name, list(args), words[1:], session,
                                  registry, namespace)
            return None if isinstance(
                refusal, Admitted) else (refusal.exit_code, _voiced(refusal))

        assert await run(plain, "cat",
                         "/data/secret") == (1, "cat: /data/secret: sealed\n")
        assert await run(veiled, "cat", "/data/secret") is None
        assert await run(plain, "ls",
                         "/data/private") == (1,
                                              "ls: /data/private: private\n")
        assert await run(veiled, "ls", "/data/private") is None
        # The followed target and the implied operand are dropped too.
        await ws.execute("ln -s /data/secret /data/l")
        assert await run(plain, "cat",
                         "/data/l") == (1, "cat: /data/l: sealed\n")
        assert await run(veiled, "cat", "/data/l") is None
        # Whatever the session sees is still read as before.
        assert await run(veiled, "cat", "/data/a") is None
        await ws.execute("echo x > /data/private/f")
        assert await run(plain, "grep", "-r", "x",
                         "/data/private") == (1,
                                              "grep: /data/private: private\n")
        assert await run(veiled, "grep", "-r", "x", "/data/private") is None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_admit_line_without_rules_admits_the_words_as_typed():
    # No command rule in force: nothing is refused for being unreadable,
    # which is what a coded policy always saw.
    ws = Workspace({"/data/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        for text in ("$cmd /data/x", 'eval "$p"', "source /data/env.sh",
                     "ls | xargs cat"):
            assert await admit_line(parse(text), session, ws._registry,
                                    ws._namespace) is None
    finally:
        await ws.close()


def test_the_admitted_gate_judges_what_the_line_did_not_name():
    deny = CommandRule(reason="sealed", paths=("/data/sealed", ))
    ask = CommandRule(reason="nod",
                      commands=("grep", ),
                      paths=("/data/asked/*", ))
    rules = AdmissionRules(ask=(ask, ), deny=(deny, ))
    gate = Admitted(rules=rules,
                    tokens=("grep", "-r", "x", "/data"),
                    judged=frozenset({"/data"}),
                    granted=(),
                    scoped=True)
    gate.check("/data")
    gate.check("/data/open/o")
    with pytest.raises(PolicyDenied) as info:
        gate.check("/data/sealed/s")
    assert info.value.errno == errno.EACCES
    assert info.value.strerror == "sealed"
    assert info.value.filename == "/data/sealed/s"
    with pytest.raises(PolicyDenied) as info:
        gate.check("/data/asked/a")
    assert info.value.strerror == "nod"
    # An operand the gate judged passes whatever the rules say about it
    # (the line was admitted on it), and a grant under the asking rule
    # opens its scope to the walk.
    judged = Admitted(rules=rules,
                      tokens=("grep", "x", "/data/asked/a"),
                      judged=frozenset({"/data/asked/a"}),
                      granted=(),
                      scoped=True)
    judged.check("/data/asked/a")
    granted = Admitted(rules=rules,
                       tokens=("grep", "-r", "x", "/data/asked"),
                       judged=frozenset({"/data/asked"}),
                       granted=(ask, ),
                       scoped=True)
    granted.check("/data/asked/a")


@pytest.mark.asyncio
async def test_admit_reports_the_grant_the_line_runs_under_and_its_scope():
    ws = _ws()
    try:
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        registry, namespace = ws._registry, ws._namespace
        words = classify_parts(["rm", "/data/x"], registry, session.cwd)
        verdict = await admit("rm", ["/data/x"], words[1:], session, registry,
                              namespace)
        assert isinstance(verdict, Admitted)
        assert verdict.tokens == ("rm", "/data/x")
        assert verdict.judged == frozenset({"/data/x"})
        assert verdict.granted == ()
        # `rm` is under no path rule in this document; `cat` is.
        assert not verdict.scoped
        words = classify_parts(["cat", "/data/a"], registry, session.cwd)
        verdict = await admit("cat", ["/data/a"], words[1:], session, registry,
                              namespace)
        assert isinstance(verdict, Admitted) and verdict.scoped
    finally:
        await ws.close()
