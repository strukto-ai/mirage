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
import errno

import pytest
from pydantic import field_serializer

from mirage import Workspace
from mirage.errors.fs import ebusy
from mirage.policy import (
    Action,
    Ask,
    CommandContext,
    CommandRule,
    Deny,
    ExecuteResultContext,
    MountRootPolicy,
    Pending,
    Policies,
    Policy,
    PolicyDenied,
    PolicyError,
    Route,
    VfsContext,
    VfsResultContext,
    describe_refusal,
    post_execute_gate,
    post_vfs_gate,
    pre_vfs_gate,
    refusal_of,
    render_deny,
)
from mirage.policy.mixin import SessionScopedMixin
from mirage.policy.policies import agreed, settled
from mirage.policy.types import RouteContext, SessionContext
from mirage.types import (
    FileStat,
    Limit,
    MountMode,
    PathSpec,
    Producer,
    Refusal,
)
from mirage.utils.abort import MirageAbortError
from mirage.vfs.ram import RAMVFS
from mirage.workspace.dispatcher.constants import CALLS
from mirage.workspace.mount import MountRegistry


class DenyWeird(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "weird":
            return Deny("nope")
        return None


class Raising(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        raise RuntimeError("boom")


class IllegalReturn(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return "not an action"  # type: ignore[return-value]


class Silent(Policy):
    pass


class AskRm(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "rm":
            return Ask("sign-off")
        return None


class AskAll(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Ask("second opinion")


class DenyRm(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "rm":
            return Deny("no")
        return None


class AskOnOps(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        return Ask("cannot wait here")


class SyncDeny(Policy):
    """A method written as a plain ``def``, the way TypeScript allows."""

    def pre_command(  # type: ignore[override]
        self, ctx: CommandContext
    ) -> Action | None:
        if ctx.command == "rm":
            return Deny("sync no")
        return None


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/data", RAMVFS(), MountMode.WRITE)
    return registry


def _path(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path="",
        raw_path=virtual,
        resolved=True,
    )


def _ctx(
    command: str,
    paths: list[PathSpec] | None = None,
) -> CommandContext:
    return CommandContext(
        command=command,
        paths=tuple(paths or []),
        argv=(),
        cwd="/",
    )


@pytest.mark.asyncio
async def test_policies_carry_no_rules_by_default():
    assert await Policies().pre_command(_ctx("rm", [_path("/data")])) is None


@pytest.mark.asyncio
async def test_registry_seeds_the_mount_root_policy():
    registry = _registry()
    deny = await registry.policies.pre_command(_ctx("rm", [_path("/data")]))
    assert deny is not None
    assert "cannot remove '/data'" in deny.reason


class UserRule(Policy):
    """A user policy refusing every rm."""

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Deny("user rule") if ctx.command == "rm" else None


@pytest.mark.asyncio
async def test_builtin_runs_first_then_user_policies_in_order():
    policies = Policies([MountRootPolicy(_registry())])
    policies.add(UserRule())
    # Both match `rm /data`; the built-in GNU message wins by order.
    deny = await policies.pre_command(_ctx("rm", [_path("/data")]))
    assert deny is not None
    assert "Is a directory" in deny.reason
    # Only the user rule matches `rm /data/x`.
    deny = await policies.pre_command(_ctx("rm", [_path("/data/x")]))
    assert deny is not None
    assert deny == Deny("user rule", policy="UserRule")
    # The command plane renders a whole-command refusal at 126, one
    # about a path in the GNU voice at 1, and one carrying an error as
    # the command's own line, whoever produced it.
    assert render_deny("rm", deny) == (b"rm: Permission denied\n", 126)
    assert render_deny("cat", Deny("sealed", path="/k")) == (
        b"cat: /k: Permission denied\n",
        1,
    )
    busy = ebusy("/x")
    assert render_deny("rm", Deny("cannot remove 'x'", error=busy)) == (
        b"rm: cannot remove 'x'\n",
        1,
    )
    assert render_deny("tar", Deny("x: Cannot open", error=busy)) == (
        b"tar: x: Cannot open\n",
        2,
    )


SEALED_TRANSFERS = (
    (
        "cp /data/sec/k /data/out/",
        "cp: cannot open '/data/sec/k' for reading: Permission denied\n",
    ),
    (
        "cp /data/open /data/sec/sub",
        "cp: cannot create regular file '/data/sec/sub/open': "
        "Permission denied\n",
    ),
    (
        "cp -T /data/open /data/sec/sub",
        "cp: cannot create regular file '/data/sec/sub': Permission denied\n",
    ),
    (
        "cp -t /data/sec/sub /data/open /data/b",
        "cp: cannot create regular file '/data/sec/sub/open': "
        "Permission denied\n"
        "cp: cannot create regular file '/data/sec/sub/b': "
        "Permission denied\n",
    ),
    (
        "cp /data/sec/dir /data/out/d",
        "cp: -r not specified; omitting directory '/data/sec/dir'\n",
    ),
    (
        "cp -r /data/sec/dir /data/out/d",
        "cp: cannot access '/data/sec/dir': Permission denied\n",
    ),
    (
        "cp -r /data/tree /data/sec/sub",
        "cp: cannot create directory '/data/sec/sub/tree': "
        "Permission denied\n",
    ),
    (
        "mv /data/sec/k /data/out",
        "mv: cannot move '/data/sec/k' to '/data/out/k': Permission denied\n",
    ),
    (
        "mv --exchange -T /data/sec/k /data/b",
        "mv: cannot exchange '/data/sec/k' and '/data/b': Permission denied\n",
    ),
    (
        "mv --exchange /data/open /data/sec/sub",
        "mv: cannot exchange '/data/open' and '/data/sec/sub/open': "
        "Permission denied\n",
    ),
    (
        "mv --exchange -t /data/sec/sub /data/open",
        "mv: cannot exchange '/data/open' and '/data/sec/sub/open': "
        "Permission denied\n",
    ),
    (
        "cp /data/sec/lnk /data/out/l",
        "cp: cannot open '/data/sec/lnk' for reading: Permission denied\n",
    ),
    (
        "cp -P /data/sec/lnk /data/out/l",
        "cp: /data/sec/lnk: Permission denied\n",
    ),
    (
        "cp -r /data/sec/dir/. /data/out/d",
        "cp: /data/sec/dir/.: Permission denied\n",
    ),
    ("cat /data/sec/k", "cat: /data/sec/k: Permission denied\n"),
    (
        "cp -r /data/tree /data/sec/new/",
        "cp: cannot create directory '/data/sec/new/': Permission denied\n",
    ),
    (
        "cd /data && cp --target-directory=sec/sub open",
        "cp: cannot create regular file 'sec/sub/open': Permission denied\n",
    ),
    (
        "cd /data && cp -tsec/sub open",
        "cp: cannot create regular file 'sec/sub/open': Permission denied\n",
    ),
)


class RefusesTargetStat(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.call.name == "stat" and ctx.path.virtual == "/data/sec/sub":
            return Deny("no looking")
        return None


@pytest.mark.asyncio
async def test_a_refused_cp_or_mv_operand_reads_as_gnu_reports_it():
    # GNU (coreutils 9.7) names the step the operand's role takes: cp
    # opens a source, reads a source directory and creates each copy, mv
    # moves a source onto its target. A link cp copies as a link, or a
    # source named "dir/.", keeps the plain line. The wording's own stats
    # are a deciding read, so a coded policy never changes them.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[RefusesTargetStat()],
    )
    rule = {"reason": "sealed", "paths": ["/data/sec/*"]}
    ws.create_session("agent", profile={"commands": {"deny": [rule]}})
    try:
        await ws.shell(
            "mkdir -p /data/sec/sub /data/sec/dir /data/out /data/tree; "
            "echo k > /data/sec/k; echo o > /data/open; echo b > /data/b; "
            "echo t > /data/tree/t; ln -s /data/open /data/sec/lnk"
        )
        for line, stderr in SEALED_TRANSFERS:
            run = await ws.shell(line, session_id="agent")
            judged = await ws.explain(line, session_id="agent")
            assert (run.exit_code, await run.stderr_str()) == (1, stderr), line
            assert (judged.exit_code, judged.stderr) == (1, stderr), line
    finally:
        await ws.close()


class StallingStat(RAMVFS):
    """A RAM mount whose stat of ``slow`` waits, once armed, until opened,
    counting the stats that start once ``cancelled`` is set."""

    def __init__(self) -> None:
        super().__init__()
        self.armed = False
        self.cancelled = False
        self.late = 0
        self.reached = asyncio.Event()
        self.gate = asyncio.Event()

    async def stat(self, path: PathSpec) -> FileStat:
        if self.cancelled:
            self.late += 1
        if self.armed and path.virtual.endswith("/slow"):
            self.reached.set()
            await self.gate.wait()
        return await super().stat(path)


@pytest.mark.asyncio
async def test_a_cancel_stops_a_refused_cp_whose_operand_stat_stalls():
    # The wording's stats run while the line is judged; a cancel ends
    # one still waiting there, and no other operand is read.
    ram = StallingStat()
    ws = Workspace({"/data/": ram}, mode=MountMode.WRITE)
    rule = {"reason": "sealed", "paths": ["/data/sec/*"]}
    ws.create_session("agent", profile={"commands": {"deny": [rule]}})
    try:
        await ws.shell(
            "mkdir -p /data/sec/sub; echo s > /data/slow; echo b > /data/b"
        )
        ram.armed = True
        line = asyncio.create_task(
            ws.shell(
                "cp -r /data/slow /data/b /data/sec/sub", session_id="agent"
            )
        )
        await asyncio.wait_for(ram.reached.wait(), 5)
        ram.cancelled = True
        assert await asyncio.wait_for(ws.cancel("agent"), 2) == 1
        with pytest.raises(MirageAbortError):
            await line
        assert ram.late == 0
    finally:
        ram.gate.set()
        await ws.close()


@pytest.mark.asyncio
async def test_policy_instances_and_unoverridden_methods():
    policies = Policies()
    policies.add(Silent())
    policies.add(DenyWeird())
    deny = await policies.pre_command(_ctx("weird"))
    assert deny == Deny("nope", policy="DenyWeird")
    assert await policies.pre_command(_ctx("normal")) is None


@pytest.mark.asyncio
async def test_a_raising_policy_fails_closed():
    policies = Policies()
    policies.add(Raising())
    deny = await policies.pre_command(_ctx("ls"))
    assert deny is not None
    assert deny.path is None
    assert deny.reason == "Raising failed"
    assert deny.policy == "Raising"
    assert deny.failed is True


@pytest.mark.asyncio
async def test_a_sync_method_is_awaited_like_the_typescript_seam():
    policies = Policies()
    policies.add(SyncDeny())
    deny = await policies.pre_command(_ctx("rm"))
    assert deny is not None
    assert deny.reason == "sync no"
    # Silence from a sync method is silence, not a swallowed TypeError.
    assert await policies.pre_command(_ctx("ls")) is None


@pytest.mark.asyncio
async def test_an_illegal_return_raises_policy_error():
    policies = Policies()
    policies.add(IllegalReturn())
    with pytest.raises(PolicyError, match="IllegalReturn"):
        await policies.pre_command(_ctx("ls"))


class DenyReadOps(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.call.name == "read":
            return Deny("no reads")
        return None


class DenyBigResults(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        if isinstance(ctx.result, bytes) and len(ctx.result) > 8:
            return Deny("result too large")
        return None


@pytest.mark.asyncio
async def test_pre_vfs_first_deny_wins_and_wants_gates():
    policies = Policies()
    assert not policies.wants("pre_vfs")
    policies.add(DenyReadOps())
    assert policies.wants("pre_vfs")
    assert not policies.wants("post_vfs")
    ctx = VfsContext(
        call=CALLS["read"], path=_path("/data/x"), write=False, prefix="/data/"
    )
    deny = await policies.pre_vfs(ctx)
    assert deny == Deny("no reads", policy="DenyReadOps")
    write_ctx = VfsContext(
        call=CALLS["write"], path=_path("/data/x"), write=True, prefix="/data/"
    )
    assert await policies.pre_vfs(write_ctx) is None


@pytest.mark.asyncio
async def test_pre_vfs_gate_raises_eacces():
    policies = Policies()
    policies.add(DenyReadOps())
    with pytest.raises(PermissionError) as excinfo:
        await pre_vfs_gate(
            policies, CALLS["read"], _path("/data/x"), False, "/data/"
        )
    assert excinfo.value.errno == errno.EACCES
    assert excinfo.value.filename == "/data/x"
    assert excinfo.value.refusal and "no reads" in excinfo.value.refusal.reason
    # No opinion on writes: the gate passes silently.
    await pre_vfs_gate(
        policies, CALLS["write"], _path("/data/x"), True, "/data/"
    )


@pytest.mark.asyncio
async def test_post_vfs_gate_suppresses_the_result():
    policies = Policies()
    policies.add(DenyBigResults())
    await post_vfs_gate(
        policies, CALLS["read"], _path("/data/x"), False, "/data/", b"tiny"
    )
    with pytest.raises(PermissionError) as excinfo:
        await post_vfs_gate(
            policies,
            CALLS["read"],
            _path("/data/x"),
            False,
            "/data/",
            b"a long secret payload",
        )
    # A post deny suppresses the result of an op that already ran; the
    # dispatcher's OpReport, stamped before this gate fires, is what keeps
    # the accounting of the completed op.
    assert excinfo.value.errno == errno.EACCES


class CapFour(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        return Limit(max_bytes=4)


class LimitOnPre(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Limit(max_bytes=1)


class CapLines(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_lines=2)


def _ops_result_ctx() -> VfsResultContext:
    return VfsResultContext(
        call=CALLS["read"],
        path=_path("/data/x"),
        write=False,
        prefix="/data/",
        result=b"payload",
    )


@pytest.mark.asyncio
async def test_a_limit_is_illegal_on_post_vfs():
    policies = Policies()
    policies.add(CapFour())
    with pytest.raises(PolicyError, match="CapFour"):
        await policies.post_vfs(_ops_result_ctx())


@pytest.mark.asyncio
async def test_a_limit_is_illegal_on_pre_command():
    policies = Policies()
    policies.add(LimitOnPre())
    with pytest.raises(PolicyError, match="LimitOnPre"):
        await policies.pre_command(_ctx("ls"))


@pytest.mark.asyncio
async def test_post_execute_gate_merges_user_limits():
    policies = Policies()
    policies.add(CapLines())
    deny, bound = await post_execute_gate(
        policies,
        ExecuteResultContext(
            line="echo",
            commands=(),
            session_id="",
            producer=Producer(command="echo"),
        ),
    )
    assert deny is None
    assert bound is not None
    assert bound.max_lines == 2


@pytest.mark.asyncio
async def test_a_deny_anywhere_in_the_chain_outranks_an_ask():
    # The loop keeps looking past an Ask for a Deny, whichever order the
    # two policies were registered in, so an approval can never re-open
    # a refusal.
    for order in ([AskRm(), DenyRm()], [DenyRm(), AskRm()]):
        policies = Policies(order)
        assert await policies.pre_command(_ctx("rm")) == Deny(
            "no", policy="DenyRm"
        )
    # With nothing refusing, every Ask is the answer: the first one's
    # voice, with each policy's rule for the host to grant.
    policies = Policies([AskRm(), AskAll()])
    assert await policies.pre_command(_ctx("rm")) == Ask(
        "sign-off",
        policy="AskRm",
        rules=(
            CommandRule("sign-off", commands=("rm",)),
            CommandRule("second opinion", commands=("rm",)),
        ),
    )
    assert await policies.pre_command(_ctx("ls")) == Ask(
        "second opinion", policy="AskAll"
    )


@pytest.mark.asyncio
async def test_an_op_ask_with_no_ledger_refuses_like_a_deny():
    # An entry point that cannot put the question (no ledger) refuses it, in
    # the deny voice, with the reason on the record.
    policies = Policies([AskOnOps()])
    with pytest.raises(PolicyDenied) as info:
        await pre_vfs_gate(
            policies, CALLS["write"], _path("/data/x"), True, "/data/"
        )
    assert info.value.errno == errno.EACCES
    assert info.value.refusal is not None
    assert info.value.refusal.kind == "deny"


class OnBeta(Policy):
    async def pre_execute(self, ctx: RouteContext) -> Action | None:
        return Route("beta")


class AskToPlace(Policy):
    async def pre_execute(self, ctx: RouteContext) -> Action | None:
        return Ask("where?")


@pytest.mark.asyncio
async def test_pre_execute_routes_agree_and_an_ask_holds_the_line():
    line = RouteContext(
        line="python3 x",
        commands=(),
        session_id="",
    )
    # Two policies naming one runtime agree; the first names the line.
    agreed = await Policies([OnBeta(), OnBeta()]).pre_execute(line)
    assert agreed == (None, Route("beta", policy="OnBeta"))
    # An Ask comes back beside the Route, for the entry point to put.
    asked = await Policies([AskToPlace(), OnBeta()]).pre_execute(line)
    assert asked == (
        Ask("where?", policy="AskToPlace"),
        Route("beta", policy="OnBeta"),
    )


def test_render_deny_words_an_open_question_as_a_deny():
    err, code = render_deny("git", Pending("abc123", "sign-off"))
    assert err == b"git: Permission denied\n"
    assert code == 126


def test_refusal_of_records_kind_policy_and_ask():
    assert refusal_of(Deny("user rule", policy="RulePolicy")) == Refusal(
        kind="deny", reason="user rule", policy="RulePolicy"
    )
    # The filesystem's own error is no policy refusal: nothing recorded.
    assert (
        refusal_of(
            Deny(
                "cannot remove 'x'",
                policy="MountRootPolicy",
                error=ebusy("/x"),
            )
        )
        is None
    )
    assert refusal_of(
        Deny("Raising failed", policy="Raising", failed=True)
    ) == Refusal(kind="failed", reason="Raising failed", policy="Raising")
    assert refusal_of(Pending("abc123", "sign-off")) == Refusal(
        kind="pending", reason="sign-off", ask_id="abc123"
    )


def test_describe_refusal_carries_the_reason_the_stderr_line_dropped():
    assert (
        describe_refusal(
            Refusal(kind="deny", reason="user rule", policy="RulePolicy")
        )
        == "policy denied: user rule"
    )
    assert (
        describe_refusal(
            Refusal(kind="pending", reason="sign-off", ask_id="abc123")
        )
        == "requires approval: sign-off (ask abc123)"
    )
    assert (
        describe_refusal(
            Refusal(kind="failed", reason="Raising failed", policy="Raising")
        )
        == "policy Raising failed"
    )


class ForSomeSessions(Policy, SessionScopedMixin):
    """Overrides the session view, but speaks only for session ``a``."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        return None

    async def wants_for(self, method: str, session_id: str) -> bool:
        return session_id == "a"


class ForEveryone(Policy):
    async def pre_session(self, ctx: SessionContext) -> Action | None:
        return None


@pytest.mark.asyncio
async def test_wants_for_refines_wants_per_session():
    # The static answer is yes as soon as any policy overrides the method,
    # and the entry points keep gating on it; the per-session answer asks a
    # session-scoped policy whether this session is one of its.
    scoped = Policies([ForSomeSessions()])
    assert scoped.wants("pre_session")
    assert await scoped.wants_for("pre_session", "a") is True
    assert await scoped.wants_for("pre_session", "b") is False
    assert await scoped.wants_for("pre_vfs", "a") is False
    # A policy speaking for every session settles it, wherever it stands.
    both = Policies([ForSomeSessions(), ForEveryone()])
    assert await both.wants_for("pre_session", "b") is True


@pytest.mark.asyncio
async def test_remove_by_identity_refreshes_methods_and_keeps_admission_order():
    policies = Policies()

    class RemovesItself(Policy):
        async def pre_command(self, ctx):
            assert policies.remove(self)
            return None

    first = RemovesItself()
    last = DenyWeird()
    policies.add(first)
    policies.add(last)
    assert not policies.remove(DenyWeird())
    refusal = await policies.pre_command(_ctx("weird"))
    assert isinstance(refusal, Deny)
    assert refusal.reason == "nope"
    assert policies.wants("pre_command")
    assert policies.remove(last)
    assert not policies.wants("pre_command")
    assert not policies.remove(first)
    assert await policies.pre_command(_ctx("weird")) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "method",
    [
        "pre_command",
        "post_command",
        "pre_execute",
        "post_execute",
        "pre_vfs",
        "post_vfs",
        "pre_session",
        "post_session",
    ],
)
async def test_composition_stops_before_an_invalid_later_action(method: str):
    def answer(self, ctx):
        return Deny("first refusal"), f"invalid later action at {method}"

    policy = type("TwoAnswers", (Policy,), {method: answer})()
    policies = Policies([policy])
    answers = await policies.answers(method, _ctx("true", []), every=False)
    assert len(answers) == 1
    assert answers[0].reason == "first refusal"
    with pytest.raises(PolicyError, match="invalid later action"):
        await policies.answers(method, _ctx("true", []), every=True)


@pytest.mark.asyncio
async def test_composition_keeps_registration_snapshot_during_suspension():
    entered = asyncio.Event()
    release = asyncio.Event()

    class Wait(Policy):
        async def pre_command(self, ctx):
            entered.set()
            await release.wait()

    policies = Policies([Wait()])
    running = asyncio.create_task(policies.pre_command(_ctx("weird", [])))
    await entered.wait()
    policies.add(DenyWeird())
    release.set()
    assert await running is None
    refused = await policies.pre_command(_ctx("weird", []))
    assert isinstance(refused, Deny)
    assert refused.reason == "nope"


@pytest.mark.asyncio
async def test_composition_cancellation_does_not_run_later_policy():
    entered = asyncio.Event()
    later_calls = []

    class Wait(Policy):
        async def pre_command(self, ctx):
            entered.set()
            await asyncio.Event().wait()

    class Later(Policy):
        async def pre_command(self, ctx):
            later_calls.append(ctx.command)

    policies = Policies([Wait(), Later()])
    running = asyncio.create_task(policies.pre_command(_ctx("true", [])))
    await entered.wait()
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert later_calls == []


@pytest.mark.asyncio
async def test_composition_does_not_inspect_unreachable_action_fields():
    reads = []

    class Later(Ask):
        @property
        def kind(self):
            reads.append("kind")
            raise RuntimeError("unreachable getter")

    class Answers(Policy):
        def pre_command(self, ctx):
            return Deny("first refusal"), Later("later ask")

    policies = Policies([Answers()])
    answer = await policies.pre_command(_ctx("true", []))
    assert isinstance(answer, Deny)
    assert reads == []
    with pytest.raises(RuntimeError, match="unreachable getter"):
        await policies.answers("pre_command", _ctx("true", []))
    assert reads == ["kind"]


def test_standalone_composition_keeps_first_agreed_route_and_ask_precedence():
    first = Route("node", reason="first placement")
    same = Route("node", reason="second placement")
    other = Route("python", reason="other placement")
    question = Ask("review")
    refusal = Deny("refused")
    assert agreed([first]) is first
    assert settled((first,)) is first
    assert settled((question, refusal, first, other)) is refusal
    assert agreed([first, same]) is first
    assert settled((first, same)) is first
    assert isinstance(agreed([first, other]), Deny)
    assert isinstance(settled((first, other)), Deny)
    assert settled((first, question, other)) is question
    assert agreed([]) is None
    assert settled(()) is None


@pytest.mark.asyncio
async def test_composition_leaves_singleton_ask_rules_unread():
    class Question(Ask):
        def __getattribute__(self, name):
            if name == "rules":
                raise RuntimeError("singleton rules read")
            return super().__getattribute__(name)

    question = Question("review", policy="First")

    class First(Policy):
        def pre_command(self, ctx):
            return question

    assert await Policies([First()]).pre_command(_ctx("true", [])) is question
    assert settled((question,)) is question


@pytest.mark.asyncio
async def test_composition_aggregates_limits_after_later_callbacks_mutate_them():
    limit = Limit(max_bytes=100)

    class First(Policy):
        def post_execute(self, ctx):
            return limit

    class Second(Policy):
        def post_execute(self, ctx):
            limit.max_bytes = 1

    ctx = ExecuteResultContext(line="true", commands=(), session_id="")
    _, merged = await Policies([First(), Second()]).post_execute(ctx)
    assert merged.max_bytes == 1


def test_pure_settlement_does_not_read_route_values_after_a_question():
    class Placement(Route):
        def __getattribute__(self, name):
            if name == "runtime":
                raise RuntimeError("suppressed route read")
            return super().__getattribute__(name)

    question = Ask("review")
    assert settled((question, Placement("node"))) is question


@pytest.mark.asyncio
async def test_composition_keeps_repeated_named_ask_identity():
    question = Ask("review", policy="Named")

    class First(Policy):
        def pre_command(self, ctx):
            return question

    result = await Policies([First(), First()]).pre_command(_ctx("true", []))
    assert result is question
    assert result.rules == ()


@pytest.mark.asyncio
async def test_composition_answers_leave_route_values_unread():
    class Placement(Route):
        def __getattribute__(self, name):
            if name == "runtime":
                raise RuntimeError("answers route read")
            return super().__getattribute__(name)

    route = Placement("node", policy="Named")

    class First(Policy):
        def pre_execute(self, ctx):
            return route

    ctx = RouteContext(line="true", commands=(), session_id="")
    assert await Policies([First()]).answers("pre_execute", ctx) == (route,)


def test_pure_route_agreement_leaves_diagnostic_policy_names_unread():
    class Placement(Route):
        def __getattribute__(self, name):
            if name == "policy":
                raise RuntimeError("unused policy name")
            return super().__getattribute__(name)

    route = Placement("node")
    assert agreed([route]) is route
    assert settled((route,)) is route


@pytest.mark.asyncio
async def test_composition_uses_raw_limit_values_instead_of_serializers():
    class DisplayLimit(Limit):
        @field_serializer("max_bytes")
        def show_bytes(self, value):
            return value + 1000

    class First(Policy):
        def post_execute(self, ctx):
            return DisplayLimit(max_bytes=1)

    ctx = ExecuteResultContext(line="true", commands=(), session_id="")
    _, limit = await Policies([First()]).post_execute(ctx)
    assert limit.max_bytes == 1


@pytest.mark.asyncio
async def test_composition_reads_all_limits_for_fields_named_by_any_limit():
    class DefaultLimit(Limit):
        max_bytes: int | None = 1

    class First(Policy):
        def post_execute(self, ctx):
            return DefaultLimit(), Limit(max_bytes=100)

    ctx = ExecuteResultContext(line="true", commands=(), session_id="")
    _, limit = await Policies([First()]).post_execute(ctx)
    assert limit.max_bytes == 1


@pytest.mark.asyncio
async def test_composition_merges_many_asks_without_recounting_prior_rules():
    rules = tuple(CommandRule(reason=f"rule {index}") for index in range(362))

    class Questions(Policy):
        def pre_command(self, ctx):
            return tuple(Ask("review", rules=(rule,)) for rule in rules)

    result = await Policies([Questions()]).pre_command(_ctx("true", []))
    assert isinstance(result, Ask)
    assert result.rules == rules
