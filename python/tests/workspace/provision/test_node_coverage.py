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

from unittest.mock import MagicMock

import pytest

from mirage import MountMode, Workspace
from mirage.policy import Policy
from mirage.policy.types import (Action, AdmissionRules, Ask, CommandContext,
                                 Deny)
from mirage.provision import Precision
from mirage.shell.node_kind import NodeKind
from mirage.vfs.ram import RAMVFS
from mirage.workspace.node.provision_node import provision_node

# Drift guard: every statement kind the executor supports must have a
# pinned provision expectation here. The map must cover the full enum
# (asserted below), so adding a NodeKind forces deciding what the
# planner reports for it; a construct can no longer be supported by
# the executor and silently mis-planned.
#
# The seeded file is 24 bytes. Expectations are
# (snippet, network_read, network_write, precision).
PLANS = {
    NodeKind.COMMENT: ("# a comment", "0", "0", "exact"),
    NodeKind.PROGRAM: ("cat /data/a.txt; cat /data/a.txt", "48", "0", "exact"),
    NodeKind.COMMAND: ("cat /data/a.txt", "24", "0", "exact"),
    NodeKind.PIPELINE: ("cat /data/a.txt | wc -l", "24", "0", "exact"),
    NodeKind.LIST: ("cat /data/a.txt && cat /data/a.txt", "48", "0", "exact"),
    NodeKind.REDIRECT:
    ("cat /data/a.txt > /data/out.txt", "24", "0-24", "range"),
    NodeKind.SUBSHELL: ("(cat /data/a.txt)", "24", "0", "exact"),
    NodeKind.COMPOUND: ("{ cat /data/a.txt; }", "24", "0", "exact"),
    NodeKind.IF: ("if true; then cat /data/a.txt; fi", "0-24", "0", "range"),
    NodeKind.FOR:
    ("for i in 1 2; do cat /data/a.txt; done", "48", "0", "exact"),
    NodeKind.SELECT:
    ("select x in a b; do cat /data/a.txt; done", "24", "0", "unknown"),
    NodeKind.WHILE:
    ("while true; do cat /data/a.txt; done", "24", "0", "unknown"),
    NodeKind.UNTIL: ("until false; do cat /data/a.txt; done", "24", "0",
                     "unknown"),
    NodeKind.CASE: ("case x in x) cat /data/a.txt;; esac", "24", "0", "range"),
    NodeKind.FUNCTION_DEF: ("f() { cat /data/a.txt; }", "0", "0", "exact"),
    NodeKind.DECLARATION: ("export FOO=1", "0", "0", "exact"),
    NodeKind.UNSET: ("unset FOO", "0", "0", "exact"),
    NodeKind.TEST: ("[[ -n x ]]", "0", "0", "exact"),
    NodeKind.NEGATED: ("! grep zzz /data/a.txt", "24", "0", "exact"),
    NodeKind.VAR_ASSIGN: ("FOO=1", "0", "0", "exact"),
    NodeKind.VAR_ASSIGNS: ("FOO=1 BAR=2", "0", "0", "exact"),
    NodeKind.CFOR: ("for ((i=0;i<2;i++)); do cat /data/a.txt; done", "24", "0",
                    "unknown"),
    # No valid syntax reaches the planner's UNSUPPORTED fallthrough:
    # the workspace syntax gate rejects ERROR trees first, so this
    # entry pins the gate, and the stub-node test below pins the
    # fallthrough plan itself.
    NodeKind.UNSUPPORTED: ("case x", "0", "0", "unknown"),
}


def test_plans_cover_the_full_enum():
    assert set(PLANS) == set(NodeKind)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(NodeKind))
async def test_every_kind_plans(kind):
    snippet, net, write, precision = PLANS[kind]
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    result = await ws.shell(snippet, provision=True)
    if kind is NodeKind.UNSUPPORTED:
        assert result.exit_code == 2
        assert await result.stderr_str(
        ) == "mirage: syntax error near 'case x'\n"
        await ws.close()
        return
    assert result.network_read == net, kind
    assert result.network_write == write, kind
    assert result.precision.value == precision, kind
    await ws.close()


class _NoCat(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "cat":
            return Deny("cats are off")
        return None


class _AskCat(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "cat":
            return Ask("cats need approval")
        return None


@pytest.mark.asyncio
async def test_provision_asks_the_command_gate_first():
    # A dry run reads the backend to price the line (stats, listings),
    # so a command the policy refuses is not estimated either: the
    # denied session must not learn byte counts the run itself would
    # never be allowed to produce.
    ws = Workspace({"/data": RAMVFS()},
                   mode=MountMode.WRITE,
                   policies=[_NoCat()])
    try:
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
        result = await ws.shell("cat /data/a.txt", provision=True)
        assert result.precision is Precision.UNKNOWN
        assert result.network_read == "0"
        priced = await ws.shell("head /data/a.txt", provision=True)
        assert priced.network_read == "0-24"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_provision_does_not_run_ahead_of_an_ask():
    # An ask cannot be raised from a dry run (nothing here may reach
    # the host), so a command that would ask is not priced before the
    # approval it would need.
    ws = Workspace({"/data": RAMVFS()},
                   mode=MountMode.WRITE,
                   policies=[_AskCat()])
    try:
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
        result = await ws.shell("cat /data/a.txt", provision=True)
        assert result.precision is Precision.UNKNOWN
        assert result.network_read == "0"
    finally:
        await ws.close()


class _NoRead(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "read":
            return Deny("no reads")
        return None


class _NoF(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "f":
            return Deny("no f")
        return None


class _Counting(Policy):

    def __init__(self) -> None:
        self.commands: list[str] = []

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        self.commands.append(ctx.command)
        return None


@pytest.mark.asyncio
async def test_provision_consults_pre_command_once_per_redirected_command():
    # The run admits `cat < file` on one call, command and targets
    # together; the plan's REDIRECT arm gates the same way and hands
    # its verdict to the inner COMMAND recursion, so a stateful or
    # metered hook is consulted exactly once per statement, never twice.
    counting = _Counting()
    ws = Workspace({"/data": RAMVFS()},
                   mode=MountMode.WRITE,
                   policies=[counting])
    try:
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
        counting.commands.clear()
        result = await ws.shell("cat < /data/a.txt", provision=True)
        assert result.network_read == "24"
        assert counting.commands == ["cat"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_provision_gates_a_builtin_before_pricing_its_redirect():
    # The executor admits every command class at one chokepoint, with
    # the statement's redirect targets judged on the same call. A
    # denied `read < file` must plan the same way: no exact-looking
    # builtin plan, and the redirect source never stat'd or priced.
    ws = Workspace({"/data": RAMVFS()},
                   mode=MountMode.WRITE,
                   policies=[_NoRead()])
    try:
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
        result = await ws.shell("read x < /data/a.txt", provision=True)
        assert result.precision is Precision.UNKNOWN
        assert result.network_read == "0"
    finally:
        await ws.close()
    control = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await control.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
        priced = await control.shell("read x < /data/a.txt", provision=True)
        assert priced.network_read == "24"
    finally:
        await control.close()


@pytest.mark.asyncio
async def test_provision_gates_a_function_before_walking_its_body():
    # A denied shell function must not have its body walked: the body's
    # own reads are byte counts the refusal is protecting.
    ws = Workspace({"/data": RAMVFS()},
                   mode=MountMode.WRITE,
                   policies=[_NoF()])
    try:
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
        result = await ws.shell("f() { cat /data/a.txt; }; f", provision=True)
        assert result.precision is Precision.UNKNOWN
        assert result.network_read == "0"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_provision_vouches_for_a_function_the_script_defines():
    # The run stores a function in the session before the call; a dry
    # run keeps it in plan state, where the allow list cannot see it.
    # The walk vouches for its own definitions, so a script that
    # defines and calls a function still plans its body under a
    # commands.allow profile that lists only the real tools it uses.
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
        session = ws._session_mgr.get(ws._session_mgr.default_id)
        session.commands = AdmissionRules(allow=("cat", "tee"))
        result = await ws.shell("f() { cat /data/a.txt; }; f", provision=True)
        assert result.network_read == "24"
        assert result.precision.value == "exact"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_unsupported_node_plans_unknown():
    fake = MagicMock()
    fake.type = "some_unknown_type_xyz"
    fake.text = b"some_unknown_type_xyz"
    result = await provision_node(MagicMock(), MagicMock(), MagicMock(), None,
                                  fake, MagicMock())
    assert result.precision is Precision.UNKNOWN
    assert result.network_read == "0"
    assert result.network_write == "0"


@pytest.mark.asyncio
async def test_function_call_and_env_prefix_plan():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    result = await ws.shell("f() { cat /data/a.txt; }; f", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.shell("f() { f; }; f", provision=True)
    assert result.precision.value == "unknown"
    result = await ws.shell("FOO=1 cat /data/a.txt", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.shell("eval 'cat /data/a.txt'", provision=True)
    assert result.precision.value == "unknown"
    result = await ws.shell("wc -l < /data/a.txt", provision=True)
    assert result.network_read == "24"
    result = await ws.shell("cat /data/a.txt > /dev/null", provision=True)
    assert result.network_write == "0"
    assert result.precision.value == "exact"
    await ws.close()


@pytest.mark.asyncio
async def test_provision_follows_symlinks_and_spans_mounts():
    ws = Workspace({
        "/data": RAMVFS(),
        "/data2": RAMVFS()
    },
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    await ws.shell("tee /data2/b.txt > /dev/null", stdin=b"y" * 6)
    await ws.shell("ln -s /data/a.txt /data2/lnk.txt")
    result = await ws.shell("cat /data2/lnk.txt", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.shell("cat /data/a.txt /data2/b.txt", provision=True)
    assert result.network_read == "30"
    assert result.read_ops == 2
    assert result.precision.value == "exact"
    result = await ws.shell("cat /data2/b.txt /data/a.txt", provision=True)
    assert result.network_read == "30"
    await ws.close()


@pytest.mark.asyncio
async def test_provision_is_dry_and_case_arms_run_fully():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    # a dry run must not execute command substitutions
    result = await ws.shell(
        "cat $(tee /data/leak.txt > /dev/null; echo /data/a.txt)",
        provision=True)
    assert result.precision.value == "unknown"
    listing = await (await ws.shell("ls /data")).stdout_str()
    assert "leak.txt" not in listing
    # a case arm runs every statement up to its ;; terminator
    out = await (
        await ws.shell("case x in x) echo one; echo two;; esac")).stdout_str()
    assert out == "one\ntwo\n"
    result = await ws.shell(
        "case x in x) cat /data/a.txt; cat /data/a.txt;; esac", provision=True)
    assert result.network_read == "48"
    # sed reads its operands; -i degrades to a floor
    result = await ws.shell("sed s/x/y/ /data/a.txt", provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "exact"
    result = await ws.shell("sed -i s/x/y/ /data/a.txt", provision=True)
    assert result.precision.value == "unknown"
    await ws.close()


@pytest.mark.asyncio
async def test_stdin_driven_and_expanded_estimates():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("tee /data/a.txt > /dev/null", stdin=b"x" * 24)
    await ws.shell("mkdir /data/tree")
    await ws.shell("tee /data/tree/b.txt > /dev/null", stdin=b"y" * 10)
    # heredoc-fed stdin is local bytes: exact zero backend I/O
    result = await ws.shell("wc -l <<EOF\nabc\nEOF", provision=True)
    assert result.network_read == "0"
    assert result.precision.value == "exact"
    # globs expand during planning
    result = await ws.shell("cat /data/tree/*.txt", provision=True)
    assert result.network_read == "10"
    assert result.precision.value == "exact"
    # recursive search walks the tree
    result = await ws.shell("grep -r y /data/tree", provision=True)
    assert result.network_read == "10"
    assert result.precision.value == "exact"
    # a suppressed substitution degrades the loop count to a floor
    result = await ws.shell("for i in $(echo 1 2); do cat /data/a.txt; done",
                            provision=True)
    assert result.network_read == "24"
    assert result.precision.value == "unknown"
    # a suppressed substitution hides the redirect target
    result = await ws.shell("cat /data/a.txt > $(echo /data/out.txt)",
                            provision=True)
    assert result.precision.value == "unknown"
    await ws.close()
