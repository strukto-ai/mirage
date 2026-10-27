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
from dataclasses import FrozenInstanceError, fields, replace

import pytest

from mirage import Action, CommandContext, Deny, Policy, Workspace
from mirage.observe import context as observe_context
from mirage.policy import (
    Ask,
    CommandResultContext,
    CommandRule,
    Decision,
    ExecuteResultContext,
    Outcome,
    PolicyDenied,
    PolicyError,
    SessionContext,
    SessionResultContext,
    VfsContext,
    VfsResultContext,
)
from mirage.policy.profile import (
    CommandsBlock,
    PathsBlock,
    ProfilePolicy,
    SessionProfile,
)
from mirage.policy.script import script_context
from mirage.policy.types import RouteContext
from mirage.runtime.python.monty import runtime as monty_runtime
from mirage.runtime.types import ScriptSource
from mirage.shell.console.types import Channel
from mirage.types import Limit, MountMode, OnExceed, PathSpec, Refusal
from mirage.utils.path import norm
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Session


def _profile(**blocks) -> dict[str, SessionProfile]:
    """The workspace's default profile, spelled as one document.

    Permissions live in exactly one place now, so what these tests used
    to pass as `permissions=` is `profiles.default`, which shapes the
    workspace's own session and every session created without a name.
    """
    return {"default": SessionProfile(**blocks)}


class NoInterpreters(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "python3":
            return Deny("interpreters are off")
        return None


@pytest.mark.asyncio
async def test_workspace_guards_refuse_before_backend_io():
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_profile(
            commands=CommandsBlock(
                deny=(
                    CommandRule(
                        reason="production data is protected",
                        commands=("rm",),
                        paths=("/data/prod/*",),
                    ),
                )
            )
        ),
    )
    try:
        await ws.shell("mkdir -p /data/prod")
        await ws.vfs.write("/data/prod/x.txt", b"keep\n")
        result = await ws.shell("rm /data/prod/x.txt")
        assert result.exit_code == 1
        assert result.stderr == (
            b"rm: cannot remove '/data/prod/x.txt': Permission denied\n"
        )
        assert result.refusal is not None
        assert result.refusal.reason == "production data is protected"
        out = await ws.shell("cat /data/prod/x.txt")
        assert out.stdout == b"keep\n"
        ok = await ws.shell(
            "rm -f /data/prod/../other.txt 2>/dev/null; echo done"
        )
        assert b"done" in ok.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policies_add_wins_over_runtime_placement():
    # python3 is runtime-bound in the default world; the pre_command
    # method fires ahead of runtime resolution, so the refusal wins.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(NoInterpreters())
        result = await ws.shell("python3 -c 'print(1)'")
        # A whole-command refusal is bash's "found but may not run".
        assert result.exit_code == 126
        assert result.stderr == b"python3: Permission denied\n"
        # The reason rides beside the GNU line, not inside it.
        assert result.refusal == Refusal(
            kind="deny", reason="interpreters are off", policy="NoInterpreters"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policies_constructor_param_accepts_instances():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[NoInterpreters()]
    )
    try:
        result = await ws.shell("python3 -c 'print(1)'")
        assert result.exit_code == 126
        assert result.stderr == b"python3: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_guards_cover_shell_builtins_and_namespace_routes():
    # source is a dispatch-level shell builtin and touch is
    # namespace-routed; neither reaches handle_command, so this pins
    # the method at the dispatch chokepoint.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_profile(
            commands=CommandsBlock(
                deny=(
                    CommandRule(reason="disabled", commands=("source",)),
                    CommandRule(
                        reason="frozen",
                        commands=("touch",),
                        paths=("/data/prod/*",),
                    ),
                )
            )
        ),
    )
    try:
        result = await ws.shell("source /data/setup.sh")
        assert result.exit_code == 126
        assert result.stderr == b"source: Permission denied\n"
        assert result.refusal == Refusal(
            kind="deny", reason="disabled", policy="PermissionsPolicy"
        )
        result = await ws.shell("touch /data/prod/x")
        assert result.exit_code == 1
        assert result.refusal and "frozen" in result.refusal.reason
        ok = await ws.shell("touch /data/dev-x && echo done")
        assert b"done" in ok.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_guards_cover_path_valued_flags():
    # shuf discovers its output path from -o, not a positional operand;
    # the policy context must include flag-valued paths.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_profile(
            commands=CommandsBlock(
                deny=(
                    CommandRule(
                        reason="prod is protected",
                        commands=("shuf",),
                        paths=("/data/prod/*",),
                    ),
                )
            )
        ),
    )
    try:
        await ws.shell("mkdir -p /data/prod")
        result = await ws.shell("shuf -e a -o /data/prod/out")
        assert result.exit_code == 1
        assert result.refusal and "prod is protected" in result.refusal.reason
        listing = await ws.shell("ls /data/prod")
        assert b"out" not in listing.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_path_guards_hold_at_the_programmatic_entry_point():
    # ws.vfs is the same seam FUSE comes through; a path-only guard
    # must refuse it, not just shell commands (#675).
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_profile(
            commands=CommandsBlock(
                deny=(
                    CommandRule(
                        reason="prod is protected", paths=("/data/prod/*",)
                    ),
                )
            )
        ),
    )
    try:
        await ws.shell("mkdir -p /data/other")
        await ws.vfs.write("/data/other/ok.txt", b"fine\n")
        with pytest.raises(PermissionError) as excinfo:
            await ws.vfs.write("/data/prod/x.txt", b"nope\n")
        assert excinfo.value.errno == errno.EACCES
        assert excinfo.value.refusal is not None
        assert "prod is protected" in excinfo.value.refusal.reason
        with pytest.raises(PermissionError):
            await ws.vfs.read("/data/prod/x.txt")
    finally:
        await ws.close()


class SuppressProdWrites(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        if ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Deny("write suppressed")
        return None


@pytest.mark.asyncio
async def test_touch_on_an_existing_file_is_a_write_at_the_dispatcher():
    # touch on an existing file mutates via setattr, not create; the
    # write classification must cover that op too, so the mount's mode
    # refuses it.
    ram = RAMVFS()
    seed = Workspace({"/data/": ram}, mode=MountMode.WRITE)
    await seed.shell("mkdir -p /data/prod")
    await seed.vfs.write("/data/prod/x.txt", b"keep\n")
    ws = Workspace({"/data/": ram}, mode=MountMode.READ)
    try:
        result = await ws.shell("touch /data/prod/x.txt")
        assert result.exit_code != 0
        assert b"Read-only file system" in result.stderr
    finally:
        await ws.close()
        await seed.close()


@pytest.mark.asyncio
async def test_post_vfs_deny_still_records_the_completed_write():
    # A post deny suppresses the result, not the effect: the backend
    # already mutated, so observation and caches must reflect the op.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /data/prod")
        ws.policies.add(SuppressProdWrites())
        with pytest.raises(PermissionError):
            await ws.vfs.write("/data/prod/x.txt", b"data\n")
        assert any(r.op == "write" for r in ws.vfs.records)
        assert await ws.vfs.read("/data/prod/x.txt") == b"data\n"
    finally:
        await ws.close()


class SuppressCapacity(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        if ctx.call.name == "statfs":
            return Deny("no capacity")
        return None


@pytest.mark.asyncio
async def test_post_vfs_deny_suppresses_a_capacity_reply():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("touch /data/f")
        ws.policies.add(SuppressCapacity())
        with pytest.raises(PermissionError):
            await ws.dispatch("statfs", PathSpec.from_str_path("/data/f"))
        result = await ws.shell("stat -f -c %b /data/f")
        assert result.exit_code == 1
        assert result.stdout == b""
    finally:
        await ws.close()


class SuppressProdReads(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        if not ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Deny("no reads")
        return None


@pytest.mark.asyncio
async def test_post_vfs_deny_records_the_bytes_a_denied_read_moved():
    # The suppressed result is the only place a read's byte count
    # lived, so without carrying it on the exception the record says
    # zero and network_bytes under-reports traffic that happened.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /data/prod")
        await ws.vfs.write("/data/prod/x.txt", b"0123456789")
        ws.vfs.records.clear()
        ws.policies.add(SuppressProdReads())
        with pytest.raises(PermissionError):
            await ws.vfs.read("/data/prod/x.txt")
        reads = [r for r in ws.vfs.records if r.op == "read"]
        assert len(reads) == 1
        assert reads[0].bytes == 10
    finally:
        await ws.close()


class CapProdReads(Policy):
    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        if not ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Limit(max_bytes=3)
        return None


class CachingRAM(RAMVFS):
    caches_reads = True
    name = "s3"

    def commands(self):
        return [replace(rc, vfs=self.name) for rc in super().commands()]


@pytest.mark.asyncio
async def test_a_post_vfs_limit_is_an_answer_it_cannot_give():
    # A kernel or protocol mount reads in ranges and must get each one
    # whole, so nothing cuts a file call's result; a Limit there is a
    # programming error in the policy, raised at the seam.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /data/prod")
        await ws.vfs.write("/data/prod/x.txt", b"0123456789")
        ws.policies.add(CapProdReads())
        with pytest.raises(PolicyError):
            await ws.vfs.read("/data/prod/x.txt")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_denied_warm_read_is_not_counted_as_network_traffic():
    # The deny suppresses a result the cache produced, so nothing
    # crossed the network; recording it against the backend would count
    # traffic that never happened.
    ws = Workspace({"/data/": CachingRAM()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /data/prod")
        await ws.vfs.write("/data/prod/x.txt", b"0123456789")
        await ws.vfs.read("/data/prod/x.txt")
        ws.vfs.records.clear()
        ws.policies.add(SuppressProdReads())
        with pytest.raises(PermissionError):
            await ws.vfs.read("/data/prod/x.txt")
        rec = ws.vfs.records[-1]
        assert rec.source == "ram"
        assert rec.is_cache is True
        assert ws.vfs.network_bytes == 0
    finally:
        await ws.close()


class ColdRemote(RAMVFS):
    caches_reads = False
    name = "s3"

    def commands(self):
        return [replace(rc, vfs=self.name) for rc in super().commands()]


class BrokenPostVfs(Policy):
    async def post_vfs(self, ctx: VfsResultContext):
        if ctx.write and ctx.path.virtual == "/data/prod/x.txt":
            return 42
        return None


@pytest.mark.asyncio
async def test_a_committed_write_is_recorded_when_bookkeeping_fails(
    tmp_path,
):
    # The backend applied the write, then a step after it (here an
    # invalid post_vfs return, but any foreign bookkeeping error looks
    # the same) blew up. The error must propagate AND the transfer must
    # stay on the books: the backend recorded it as it wrote, so the
    # record does not depend on what kind of exception followed.
    ws = Workspace(
        {"/data/": DiskVFS(root=str(tmp_path))}, mode=MountMode.WRITE
    )
    try:
        await ws.shell("mkdir -p /data/prod")
        ws.vfs.records.clear()
        ws.policies.add(BrokenPostVfs())
        with pytest.raises(PolicyError):
            await ws.vfs.write("/data/prod/x.txt", b"123456")
        assert await ws.vfs.read("/data/prod/x.txt") == b"123456"
        writes = [r for r in ws.vfs.records if r.op == "write"]
        assert [(r.source, r.bytes) for r in writes] == [("disk", 6)]
        assert ws.vfs.network_bytes >= 6
    finally:
        await ws.close()


class SealedPaths(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if not ctx.write and ctx.path.virtual == "/data/secret.txt":
            return Deny("secret is sealed")
        # The subtree spelling covers the root too.
        if ctx.write and (
            ctx.path.virtual == "/data/prod"
            or ctx.path.virtual.startswith("/data/prod/")
        ):
            return Deny("prod is read-only")
        return None


@pytest.mark.asyncio
async def test_pre_vfs_judges_file_calls_commands_and_redirects():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /data/prod")
        await ws.vfs.write("/data/secret.txt", b"sealed\n")
        await ws.vfs.write("/data/prod/keep.txt", b"keep\n")
        rec = OpRecorder()
        ws.policies.add(rec)
        ws.policies.add(SealedPaths())

        with pytest.raises(PermissionError):
            await ws.vfs.read("/data/secret.txt")
        with pytest.raises(PermissionError):
            await ws.vfs.write("/data/prod/new.txt", b"hi\n")
        rec.asked.clear()

        for line in (
            "echo hi > /data/prod/new.txt",
            "cat /data/secret.txt",
            "head -c 3 /data/secret.txt",
            "rm /data/prod/keep.txt",
            "find /data/prod -name keep.txt -delete",
            "rm -r /data/prod",
        ):
            result = await ws.shell(line)
            assert result.exit_code != 0, line
            assert result.stdout == b"", line
            assert b"Permission denied" in result.stderr, line
        assert await ws.vfs.read("/data/prod/keep.txt") == b"keep\n"
        assert not await ws.vfs.exists("/data/prod/new.txt")
        assert any(
            path == "/data/secret.txt" and not write
            for _, path, write in rec.asked
        )
        assert any(
            path == "/data/prod/new.txt" and write
            for _, path, write in rec.asked
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_path_rules_hold_walks_and_lazy_readers():
    # A walk is held per entry (GNU's unreadable-file shape: the other
    # entries still serve, stderr names the refused one), and a reader
    # the output pipeline drains after dispatch (head binds a lazy
    # stream) is refused as it is admitted.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_profile(
            commands=CommandsBlock(
                deny=(
                    CommandRule(reason="sealed", paths=("/data/secret.txt",)),
                )
            )
        ),
    )
    try:
        await Session(
            ws, ws.create_session("host", profile={}).session_id
        ).vfs.write("/data/secret.txt", b"sealed\n")
        await ws.vfs.write("/data/ok.txt", b"has sealed word\n")

        walked = await ws.shell("grep -r sealed /data")
        assert walked.exit_code == 2
        assert b"/data/ok.txt:has sealed word" in walked.stdout
        assert b"sealed\n" not in walked.stdout.replace(
            b"has sealed word\n", b""
        )
        assert b"grep: /data/secret.txt: Permission denied" in walked.stderr

        lazy = await ws.shell("head -c 3 /data/secret.txt")
        assert lazy.exit_code != 0
        assert (
            b"head: cannot open '/data/secret.txt' for reading: "
            b"Permission denied"
        ) in lazy.stderr
        fine = await ws.shell("head -c 3 /data/ok.txt")
        assert fine.exit_code == 0
        assert fine.stdout == b"has"
    finally:
        await ws.close()


SEALED_SECRET = SessionProfile(
    commands=CommandsBlock(
        deny=(CommandRule(reason="sealed", paths=("/data/secret.txt",)),)
    )
)


@pytest.mark.asyncio
async def test_path_rule_denied_entries_still_list_and_stat():
    # Presence facts stay unguarded on the command tier (mode-000
    # shape): a read-denied entry lists and stats, the read of it is
    # what fails.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.vfs.write("/data/secret.txt", b"sealed\n")
        ws.create_session("sealed", profile=SEALED_SECRET)
        listing = await ws.shell("ls -l /data", session_id="sealed")
        assert listing.exit_code == 0
        assert b"secret.txt" in listing.stdout
        found = await ws.shell("find /data -type f", session_id="sealed")
        assert found.exit_code == 0
        assert b"/data/secret.txt" in found.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_path_rules_hold_warm_reads():
    # The read cache is shared by every session, so a copy an earlier
    # read warmed is still the rule's to admit: each command that
    # reads through the cache answers as it would cold.
    vfs = RAMVFS()
    vfs.caches_reads = True
    ws = Workspace({"/data/": vfs}, mode=MountMode.WRITE)
    try:
        await ws.vfs.write("/data/secret.txt", b"sealed\n")
        await ws.vfs.write("/data/ok.txt", b"has sealed word\n")
        for line in ("cat /data/secret.txt", "cat /data/ok.txt"):
            assert (await ws.shell(line)).exit_code == 0
        ws.create_session("sealed", profile=SEALED_SECRET)
        for line in (
            "grep sealed /data/secret.txt",
            "rg sealed /data/secret.txt",
            "head -c 3 /data/secret.txt",
            "tail -c 3 /data/secret.txt",
            "wc -c /data/secret.txt",
            "grep -r sealed /data",
        ):
            io = await ws.shell(line, session_id="sealed")
            assert b"sealed\n" not in (io.stdout or b""), line
            assert io.exit_code != 0, line
        fine = await ws.shell("grep sealed /data/ok.txt", session_id="sealed")
        assert fine.stdout == b"has sealed word\n"
    finally:
        await ws.close()


class OpRecorder(Policy):
    def __init__(self) -> None:
        self.asked: list[tuple[str, str, bool]] = []

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        self.asked.append((ctx.call.name, ctx.path.virtual, ctx.write))
        return None


@pytest.mark.asyncio
async def test_pre_vfs_sees_the_session_of_a_file_call():
    # VfsContext.session_id names the session a call is made as, so a
    # session-scoped policy holds on a session's own file calls.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.vfs.write("/data/ok.txt", b"fine\n")
        rec = SessionRecorder()
        ws.policies.add(rec)
        agent = Session(ws, ws.create_session("agent").session_id).vfs
        assert await agent.read("/data/ok.txt") == b"fine\n"
        assert await ws.vfs.read("/data/ok.txt") == b"fine\n"
        reads = [sid for op, path, sid in rec.asked if path == "/data/ok.txt"]
        assert reads == ["agent", ws.default_session_id]
    finally:
        await ws.close()


class SessionRecorder(Policy):
    def __init__(self) -> None:
        self.asked: list[tuple[str, str, str]] = []

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        self.asked.append((ctx.call.name, ctx.path.virtual, ctx.session_id))
        return None


class CapLines(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_lines=2)


@pytest.mark.asyncio
async def test_user_limit_policy_caps_line_output():
    # A user Limit merges with the built-in cap (tightest wins) and
    # bounds what execute() returns.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapLines())
        await ws.vfs.write("/data/big.txt", b"1\n2\n3\n4\n5\n")
        r = await ws.shell("cat /data/big.txt")
        assert (await r.stdout_str()).count("\n") == 2
        assert "output truncated" in (await r.stderr_str())
    finally:
        await ws.close()


class CapBytesHard(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_bytes=4, on_exceed=OnExceed.ERROR)


class Boom(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        raise RuntimeError("boom")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "policy, command, stdout, stderr, exit_code, failed",
    [
        (
            CapLines,
            "printf '1\\n2\\n3\\n'; echo fourth",
            b"1\n2\n",
            b"output truncated",
            0,
            False,
        ),
        (
            CapBytesHard,
            "echo secret; echo more",
            b"",
            b"output truncated",
            1,
            False,
        ),
        (
            Boom,
            "echo secret; echo forbidden >&2",
            b"",
            b"forbidden\necho: Permission denied\n",
            126,
            True,
        ),
    ],
    ids=["truncate", "hard-limit", "failed-policy"],
)
async def test_stream_exposes_only_post_execute_approved_output(
    policy, command, stdout, stderr, exit_code, failed
):
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(policy())
        execution = await ws.shell(command, stream=True)
        output = {Channel.STDOUT: bytearray(), Channel.STDERR: bytearray()}
        async with execution:
            async for event in execution.events:
                output[event.stream].extend(event.data)
            result = await execution.wait()
        assert bytes(output[Channel.STDOUT]) == stdout
        assert stderr in output[Channel.STDERR]
        assert result.exit_code == exit_code
        assert await result.materialize_stdout() == b""
        assert await result.materialize_stderr() == b""
        if failed:
            assert bytes(output[Channel.STDERR]) == stderr
            assert result.refusal == Refusal(
                kind="failed", reason="Boom failed", policy="Boom"
            )
        else:
            assert result.refusal is None
    finally:
        await ws.close()


class SeeProducer(Policy):
    def __init__(self) -> None:
        self.seen: list[str] = []

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        self.seen.append(ctx.producer.command)
        return None


@pytest.mark.asyncio
async def test_two_limit_policies_merge_to_the_tightest_end_to_end():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapLines())
        ws.policies.add(SuppressNothingCapThree())
        await ws.vfs.write("/data/big.txt", b"1\n2\n3\n4\n5\n")
        r = await ws.shell("cat /data/big.txt")
        # CapLines says 2, SuppressNothingCapThree says 3: tightest wins.
        assert (await r.stdout_str()).count("\n") == 2
    finally:
        await ws.close()


class SuppressNothingCapThree(Policy):
    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_lines=3)


@pytest.mark.asyncio
async def test_error_mode_limit_fails_the_line():
    # ANY-error: a user policy in error mode turns overflow into exit 1
    # with no stdout, GNU-style notice on stderr.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapBytesHard())
        await ws.vfs.write("/data/f.txt", b"hello world\n")
        r = await ws.shell("cat /data/f.txt")
        assert r.exit_code == 1
        assert r.stdout is None or await r.stdout_str() == ""
        assert "output truncated" in (await r.stderr_str())
        ok = await ws.shell("echo ok")
        assert ok.exit_code == 0  # within the bound: no refusal
        assert await ok.stdout_str() == "ok\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_raising_post_execute_policy_fails_the_line_closed():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(Boom())
        r = await ws.shell("echo hi")
        assert r.exit_code == 126
        err = await r.stderr_str()
        assert err == "echo: Permission denied\n"
        assert r.refusal == Refusal(
            kind="failed", reason="Boom failed", policy="Boom"
        )
        assert r.stdout is None or await r.stdout_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_post_execute_sees_the_rightmost_producer():
    # The provenance a policy reads follows shell semantics: the tail
    # of a pipe, the right side of `;` and `||`.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        spy = SeeProducer()
        ws.policies.add(spy)
        await ws.vfs.write("/data/f.txt", b"a\nb\n")
        await ws.shell("cat /data/f.txt | wc -l")
        await ws.shell("cat /data/f.txt ; head -n 1 /data/f.txt")
        await ws.shell("false || cat /data/f.txt")
        # Builtins carry provenance too: a policy keyed on echo sees it.
        await ws.shell("echo hi")
        await ws.shell("cat /data/f.txt ; echo done")
        assert spy.seen == ["wc", "head", "cat", "echo", "echo"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_profile_hides_bind_every_session_including_the_default():
    ram = RAMVFS()
    ws = Workspace(
        {"/data/": ram},
        mode=MountMode.WRITE,
        profiles=_profile(paths=PathsBlock(hide=("/data/finance", "*.key"))),
    )
    # The facade runs as the default session too, so the seed goes
    # through a session with an explicit empty profile, the host's entry point.
    host = Session(ws, ws.create_session("host", profile={}).session_id).vfs
    try:
        await ws.shell("mkdir -p /data/finance /data/pub")
        await host.write("/data/pub/a.txt", b"a\n")
        await host.write("/data/pub/b.key", b"k\n")
        # The default session cannot see the bound hides ...
        listing = await ws.shell("ls /data /data/pub")
        assert b"finance" not in listing.stdout
        assert b"b.key" not in listing.stdout
        assert b"a.txt" in listing.stdout
        # ... and neither can one created later from the same profile.
        ws.create_session("late")
        gone = await ws.shell("cat /data/pub/b.key", session_id="late")
        assert gone.exit_code != 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_sections_hides_are_written_in_full():
    # The section's entries are absolute, checked at load time to lie
    # under the mount root. They used to be relative and joined onto the
    # root, which silently doubled a path already written in full
    # (`/repo/secret` under `/repo` became `/repo/repo/secret`).
    repo = RAMVFS()
    other = RAMVFS()
    ws = Workspace(
        {
            "/repo/": (repo, MountMode.WRITE),
            "/other/": (other, MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "mounts": {
                    "/repo": {"paths": {"hide": ["/repo/.env", "/repo/*.pem"]}}
                }
            }
        },
    )
    host = Session(ws, ws.create_session("host", profile={}).session_id).vfs
    try:
        await ws.shell("mkdir -p /repo/certs /other")
        await host.write("/repo/.env", b"S=1\n")
        await host.write("/repo/certs/k.pem", b"pem\n")
        await host.write("/repo/README", b"r\n")
        await host.write("/other/.env", b"visible\n")
        await host.write("/other/x.pem", b"visible\n")
        listing = await ws.shell("ls -a /repo /repo/certs /other")
        out = listing.stdout.decode()
        # The section reaches only under its own root, so the same two
        # names outside the mount are untouched.
        assert ".env" in out.split("/other:")[1]
        assert "x.pem" in out
        assert "k.pem" not in out
        assert "README" in out
        repo_part = out.split("/other:")[0]
        assert ".env" not in repo_part.replace("/repo/certs:", "")
        hidden = await ws.shell("cat /repo/.env")
        assert hidden.exit_code != 0
        shown = await ws.shell("cat /other/.env")
        assert shown.stdout == b"visible\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_bare_name_under_deny_refuses_with_the_default_reason():
    # The document's deny rules compile at construction; a bare string
    # is one command name with the default reason.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_profile(commands=CommandsBlock(deny=("shred",))),
    )
    try:
        result = await ws.shell("shred /data/x")
        assert result.exit_code == 126
        assert result.stderr == b"shred: Permission denied\n"
    finally:
        await ws.close()


# What every policy program starts with: its context, as JSON.
CONTEXT = """\
import json
import os

ctx = json.loads(os.environ['MIRAGE_POLICY_CTX'])
"""

# A per-command judge: deny cat under /data/sealed/ with a computed
# reason, take shred to the approval ledger, stay silent otherwise. A
# program prints its answer, and null is silence.
JUDGE = (
    CONTEXT
    + """
def answer():
    for p in ctx['paths']:
        if ctx['command'] == 'cat' and p.startswith('/data/sealed/'):
            return {'kind': 'deny', 'reason': 'sealed by ' + ctx['profile']}
    if ctx['command'] == 'shred':
        return {'kind': 'ask', 'reason': 'sign-off'}
    return None

print(json.dumps(answer()))
"""
)

# A judge that reads what the operand holds, not what it is called:
# the shape a content policy takes when it is a program.
READER = (
    CONTEXT
    + """
def answer():
    for p in ctx['paths']:
        try:
            body = open(p).read()
        except OSError:
            continue
        if 'payload' in body:
            return {'kind': 'ask', 'reason': 'sign-off on payload'}
    return None

print(json.dumps(answer()))
"""
)


def _scripted(
    programs: dict[str, str] | None = None, runtime: str = "monty"
) -> dict[str, dict[str, object]]:
    """One profile named release with a policy and nothing else, so
    what runs is purely the policy's decision.

    Args:
        programs (dict[str, str] | None): each method's program; the
            judge at pre_command when None.
        runtime (str): the runtime every program runs on.
    """
    return {
        "release": {
            "policy": {
                method: [{"script": ScriptSource(source), "runtime": runtime}]
                for method, source in (
                    programs or {"pre_command": JUDGE}
                ).items()
            },
        }
    }


@pytest.mark.asyncio
async def test_a_profile_script_judges_each_command():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=_scripted()
    )
    try:
        await ws.shell("mkdir -p /data/sealed && echo k > /data/sealed/k")
        ws.create_session("s", profile="release")
        assert (await ws.shell("echo hi", session_id="s")).exit_code == 0
        denied = await ws.shell("cat /data/sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_script_naming_no_runtime_runs_on_monty():
    profiles = {
        "release": {
            "policy": {"pre_command": [{"script": ScriptSource(JUDGE)}]}
        }
    }
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=profiles
    )
    try:
        await ws.shell("mkdir -p /data/sealed && echo k > /data/sealed/k")
        ws.create_session("s", profile="release")
        assert (await ws.shell("echo hi", session_id="s")).exit_code == 0
        denied = await ws.shell("cat /data/sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_script_without_monty_fails_closed(monkeypatch):
    monkeypatch.setattr(monty_runtime, "pydantic_monty", None)
    profiles = {
        "release": {
            "policy": {"pre_command": [{"script": ScriptSource(JUDGE)}]}
        }
    }
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=profiles
    )
    try:
        ws.create_session("s", profile="release")
        refused = await ws.shell("echo hi", session_id="s")
        assert refused.exit_code == 126
        assert refused.refusal is not None
        assert "names runtime 'monty'" in refused.refusal.reason
        assert "monty' extra" in refused.refusal.reason
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_script_reads_resolved_paths_not_typed_words():
    # `cd /data && cat sealed/k` names no /data/sealed word; the gate
    # hands the script the resolved operand, so the deny still lands.
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=_scripted()
    )
    try:
        ws.create_session("s", profile="release")
        denied = await ws.shell("cd /data && cat sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_script_only_profile_installs_everything():
    # No allow list, so nothing is hidden: a command no document names
    # runs whenever the script stays silent on it.
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=_scripted()
    )
    try:
        await ws.shell("echo x > /data/x")
        ws.create_session("s", profile="release")
        assert (await ws.shell("rm /data/x", session_id="s")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_document_may_ride_beside_the_script():
    # Optional, not required: a profile stating both keeps the allow
    # list, and the script adds its verdicts beside it.
    profiles = _scripted()
    profiles["release"]["commands"] = {"allow": ["ls", "cat", "echo"]}
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=profiles
    )
    try:
        ws.create_session("s", profile="release")
        unlisted = await ws.shell("rm /data/x", session_id="s")
        assert unlisted.exit_code == 126
        denied = await ws.shell("cat /data/sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_ask_it_computed_takes_the_approval_entry_point():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=_scripted()
    )
    try:
        ws.create_session("s", profile="release")
        held = await ws.shell("shred /data/x", session_id="s")
        assert held.exit_code == 126
        assert held.stderr is not None
        assert held.stderr == b"shred: Permission denied\n"
        assert held.refusal is not None
        assert (held.refusal.kind, held.refusal.reason) == (
            "pending",
            "sign-off",
        )
        assert held.refusal.ask_id
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_script_reads_what_the_line_names():
    # Content, not names: the script opens each operand through the
    # same entry point an agent's program would, so it can ask about what a
    # file holds. A directory operand is not its business, and a file
    # without the marker runs.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_scripted({"pre_command": READER}),
    )
    try:
        await ws.shell(
            "mkdir -p /data/in && "
            "printf 'subject: invoice\\n\\na payload\\n' "
            "> /data/in/mail.txt && "
            "echo plain > /data/in/note.txt"
        )
        ws.create_session("s", profile="release")
        held = await ws.shell("cat /data/in/mail.txt", session_id="s")
        assert held.exit_code == 126
        assert held.refusal is not None
        assert (held.refusal.kind, held.refusal.reason) == (
            "pending",
            "sign-off on payload",
        )
        plain = await ws.shell("cat /data/in/note.txt", session_id="s")
        assert plain.exit_code == 0
        assert (await ws.shell("ls /data/in", session_id="s")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_scripted_profile_leaves_other_sessions_alone():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=_scripted()
    )
    try:
        await ws.shell("mkdir -p /data/sealed && echo k > /data/sealed/k")
        ws.create_session("s", profile="release")
        read = await ws.shell("cat /data/sealed/k")
        assert read.exit_code == 0
        assert read.stdout == b"k\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_scripted_default_profile_shapes_the_default_session():
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_scripted(),
        profile="release",
    )
    try:
        assert (await ws.shell("echo hi")).exit_code == 0
        denied = await ws.shell("cat /data/sealed/k")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_script_runs_in_a_world_with_no_evaluator():
    # A profile is operator configuration, so the engine that judges for
    # it is a property of the profile. The runtime world is the ordered
    # set that serves *agent* code: it is mutable after construction and
    # drops entries silently when an optional dependency is missing, so
    # an engine resolved out of it would stop working for reasons that
    # have nothing to do with the profile.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        runtimes=["workspace"],
        profiles=_scripted(),
    )
    try:
        ws.create_session("s", profile="release")
        denied = await ws.shell("cat /data/sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_broken_script_fails_closed_per_command():
    # Silence on failure would run exactly the commands the script
    # existed to judge.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_scripted({"pre_command": "raise ValueError('boom')"}),
    )
    try:
        ws.create_session("s", profile="release")
        refused = await ws.shell("echo hi", session_id="s")
        assert refused.exit_code == 126
        assert refused.stderr == b"echo: Permission denied\n"
        assert refused.refusal is not None
        assert refused.refusal.reason.startswith(
            "profile 'release' policy exited "
        )
        assert (await ws.shell("echo hi")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_runtime_policies_do_not_run_on_fails_closed():
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_scripted(runtime="local"),
    )
    try:
        ws.create_session("s", profile="release")
        refused = await ws.shell("echo hi", session_id="s")
        assert refused.exit_code == 126
        assert refused.stderr == b"echo: Permission denied\n"
        assert refused.refusal is not None
        assert refused.refusal.reason == (
            "profile 'release' policy names runtime 'local'; a policy "
            "program runs on monty or wasi"
        )
    finally:
        await ws.close()


def test_the_old_script_and_runtime_keys_are_told_the_new_block():
    # Shipped first as `script` with `runtime` beside it, a word for
    # what the file is rather than what it does and an engine that read
    # as the profile's own; the refusal says where they went.
    with pytest.raises(ValueError, match="now a policy block"):
        Workspace(
            {"/data/": RAMVFS()},
            mode=MountMode.WRITE,
            profiles={
                "release": {
                    "script": ScriptSource(JUDGE),
                    "runtime": "monty",
                }
            },
        )


@pytest.mark.asyncio
async def test_a_program_printing_something_else_fails_closed():
    # stdout is the answer: anything but one JSON answer or nothing is
    # refused rather than guessed at.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_scripted({"pre_command": "print('looks fine to me')"}),
    )
    try:
        ws.create_session("s", profile="release")
        refused = await ws.shell("echo hi", session_id="s")
        assert refused.exit_code == 126
        assert refused.refusal is not None
        assert refused.refusal.reason.startswith(
            "profile 'release' policy must print a JSON answer at pre_command"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_inline_document_may_not_add_a_policy():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        with pytest.raises(PolicyError, match="not a policy"):
            ws.create_session(
                "s",
                permissions=SessionProfile(
                    policy={
                        "pre_command": [
                            ProfilePolicy(
                                script=ScriptSource(JUDGE), runtime="monty"
                            )
                        ]
                    }
                ),
            )
    finally:
        await ws.close()


# Programs at the op and session views and nowhere else: writes under
# /data/frozen are refused, so is an AWS_* variable, and a command is
# never judged.
FROZEN = (
    CONTEXT
    + """
if ctx['write'] and ctx['path'].startswith('/data/frozen/'):
    print(json.dumps({'kind': 'deny', 'reason': 'frozen by ' + ctx['profile']}))
"""
)
CREDENTIALS = (
    CONTEXT
    + """
if ctx['key'].startswith('AWS_'):
    reason = 'credentials are set by the operator'
    print(json.dumps({'kind': 'deny', 'reason': reason}))
"""
)
GATES = {"pre_vfs": FROZEN, "pre_session": CREDENTIALS}


@pytest.mark.asyncio
async def test_a_profile_policy_judges_its_sessions_file_calls():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=_scripted(GATES)
    )
    try:
        await ws.shell("mkdir -p /data/frozen && echo keep > /data/frozen/k")
        ws.create_session("s", profile="release")
        files = Session(ws, "s").vfs
        # A read is not a write.
        assert await files.read("/data/frozen/k") == b"keep\n"
        with pytest.raises(PermissionError):
            await files.write("/data/frozen/f", b"x\n")
        with pytest.raises(PermissionError):
            await files.unlink("/data/frozen/k")
        assert await ws.vfs.read("/data/frozen/k") == b"keep\n"
        ran = await ws.shell("echo x > /data/frozen/f", session_id="s")
        assert ran.exit_code == 1
        assert not await ws.vfs.exists("/data/frozen/f")
        # Another session is not judged by it.
        await ws.vfs.write("/data/frozen/g", b"x\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_policy_judges_the_session_view():
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, profiles=_scripted(GATES)
    )
    try:
        ws.create_session("s", profile="release")
        refused = await ws.shell("export AWS_SECRET=x", session_id="s")
        assert refused.exit_code == 1
        assert refused.stderr == b"AWS_SECRET: permission denied\n"
        assert refused.refusal is not None
        assert refused.refusal.reason == "credentials are set by the operator"
        landed = await ws.shell("export SAFE=1 && echo $SAFE", session_id="s")
        assert landed.exit_code == 0
        assert landed.stdout == b"1\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_policys_own_read_passes_the_dispatcher_its_op_method_guards():
    # pre_command opens the operand through the workspace's dispatcher while
    # pre_vfs stands at it: the read is the policy's own and is let
    # through rather than re-entering the evaluation waiting on it, so
    # the content verdict lands and the op method still refuses a write.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_scripted({"pre_command": READER, "pre_vfs": FROZEN}),
    )
    try:
        await ws.shell(
            "mkdir -p /data/in && printf 'subject: invoice\\n\\n"
            "a payload\\n' > /data/in/mail.txt && "
            "echo plain > /data/in/note.txt"
        )
        ws.create_session("s", profile="release")
        held = await ws.shell("cat /data/in/mail.txt", session_id="s")
        assert held.exit_code == 126
        assert held.refusal is not None
        assert held.refusal.kind == "pending"
        assert held.refusal.reason == "sign-off on payload"
        assert (
            await ws.shell("cat /data/in/note.txt", session_id="s")
        ).exit_code == 0
        with pytest.raises(PermissionError):
            await Session(ws, "s").vfs.write("/data/frozen/f", b"x\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("command", "exit_code"),
    [
        ("find /data/src", 1),
        ("du -a /data/src", 1),
        ("du -s /data/src", 1),
        ("grep -r PRIVATE_SENTINEL /data/src", 2),
        ("rg PRIVATE_SENTINEL /data/src", 2),
    ],
)
async def test_recursive_commands_enforce_admitted_path_rules(
    command, exit_code
):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /data/src/cache")
        await ws.vfs.write(
            "/data/src/cache/private.txt", b"PRIVATE_SENTINEL\n"
        )
        await ws.vfs.write("/data/src/public.txt", b"public\n")
        ws.create_session(
            "restricted",
            profile=SessionProfile(
                commands=CommandsBlock(
                    deny=(
                        CommandRule(
                            reason="sealed", paths=("/data/src/cache",)
                        ),
                    )
                )
            ),
        )

        result = await ws.shell(command, session_id="restricted")

        assert result.exit_code == exit_code
        assert b"private.txt" not in (result.stdout or b"")
        assert b"PRIVATE_SENTINEL" not in (result.stdout or b"")
        assert b"/data/src/cache" in result.stderr
        assert b"Permission denied" in result.stderr
    finally:
        await ws.close()


class AskSecrets(Policy):
    async def pre_session(self, ctx: SessionContext) -> Action | None:
        return Ask("secret write") if ctx.key.startswith("SECRET") else None


@pytest.mark.asyncio
async def test_a_pre_session_ask_a_host_answers_inline_writes():
    asked: list[Decision] = []

    async def approve(record: Decision) -> Decision:
        asked.append(record)
        return replace(record, outcome=Outcome.ALLOW)

    ws = Workspace(
        {"/data/": RAMVFS()}, policies=[AskSecrets()], on_ask=approve
    )
    try:
        assert (await ws.shell("export SECRET_A=1")).exit_code == 0
        assert (await ws.shell("echo $SECRET_A")).stdout == b"1\n"
        assert [r.argv for r in asked] == [("SECRET_A", "1")]
    finally:
        await ws.close()


class AskAround(Policy):
    async def pre_session(self, ctx: SessionContext) -> Action | None:
        return Ask("before")

    async def post_session(self, ctx: SessionResultContext) -> Action | None:
        return Ask("after")


async def _asked(
    ws: Workspace, line: str, count: int
) -> list[set[tuple[str, ...]]]:
    asked = []
    for _ in range(count):
        held = await ws.shell(line)
        assert held.refusal is not None and held.refusal.kind == "pending"
        records = ws.decisions.pending()
        asked.append({(r.reason, *r.argv) for r in records})
        for record in records:
            await ws.decisions.answer(record.id, Outcome.ALLOW)
    return asked


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["export B=1", "B=1 true", "{ export B=1; } & wait"]
)
async def test_a_write_asked_before_and_after_asks_each_once(line: str):
    # The nod to the first question stands while the second waits.
    ws = Workspace({"/data/": RAMVFS()}, policies=[AskAround()])
    try:
        asked = await _asked(ws, line, 2)
        assert asked == [{("before", "B", "1")}, {("after", "B", "1")}]
        assert (await ws.shell(line)).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_writes_of_a_line_are_spent_when_it_ends():
    # A retry finds the nods for the writes before the one it waits on.
    ws = Workspace({"/data/": RAMVFS()}, policies=[AskAround()])
    try:
        line = "B=1 true; export C=2"
        asked = await _asked(ws, line, 2)
        assert asked == [
            {("before", "B", "1"), ("before", "C", "2")},
            {("after", "B", "1"), ("after", "C", "2")},
        ]
        assert (await ws.shell(line)).exit_code == 0
        assert (await _asked(ws, line, 1)) == [
            {("before", "B", "1"), ("before", "C", "2")}
        ]
    finally:
        await ws.close()


class AskAB(Policy):
    async def pre_session(self, ctx: SessionContext) -> Action | None:
        return Ask(f"{ctx.key} needs a nod") if ctx.key in ("A", "B") else None


@pytest.mark.asyncio
async def test_a_killed_job_spends_the_nods_it_held():
    # A job held on a question and then killed is never retried.
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[AskAB()]
    )
    try:
        await ws.shell("{ export A=1; export B=2; } & wait")
        (nod,) = (r for r in ws.decisions.pending() if r.argv[0] == "A")
        await ws.decisions.answer(nod.id, Outcome.ALLOW)
        killed = await ws.shell(
            "{ export A=1; export B=2; touch /data/m; sleep 30; } & "
            "until [ -e /data/m ]; do sleep 0.1; done; kill %1; wait"
        )
        assert killed.refusal is not None and killed.refusal.kind == "pending"
        later = await ws.shell("export A=1")
        assert later.refusal is not None and later.refusal.kind == "pending"
    finally:
        await ws.close()


class AskReads(Policy):
    def __init__(self) -> None:
        self.seen: list[tuple[VfsContext, VfsContext]] = []
        self._pre: list[VfsContext] = []

    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        self._pre.append(ctx)
        return None

    async def post_vfs(self, ctx: VfsResultContext) -> Action | None:
        self.seen.append((self._pre[-1], ctx))
        return Ask("read sign-off") if ctx.call.name == "read" else None


@pytest.mark.asyncio
async def test_a_post_vfs_ask_holds_the_result_back_until_approved():
    # The call ran; what came back waits on the host, and the approved
    # retry runs it again. The method saw what pre_vfs saw.
    policy = AskReads()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("echo x > /data/x")
        ws.policies.add(policy)
        with pytest.raises(PolicyDenied) as info:
            await ws.vfs.read("/data/x")
        assert info.value.refusal is not None
        assert info.value.refusal.kind == "pending"
        pre, post = policy.seen[-1]
        fields = ("call", "path", "write", "prefix", "session_id", "mode")
        assert [getattr(post, f) for f in fields] == [
            getattr(pre, f) for f in fields
        ]
        assert post.result == b"x\n"
        await ws.decisions.answer(info.value.refusal.ask_id, Outcome.ALLOW)
        assert await ws.vfs.read("/data/x") == b"x\n"
    finally:
        await ws.close()


class AskRemovals(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Ask("removal") if ctx.command == "rm" else None


class AskEverything(Policy):
    async def pre_command(self, ctx: CommandContext) -> Action | None:
        return Ask("anything")


@pytest.mark.asyncio
async def test_every_ask_in_a_chain_is_put_to_the_host():
    # Two policies ask about one command: the host approves each, one
    # question at a time, and the command runs once both are approved.
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[AskRemovals(), AskEverything()],
    )
    try:
        reasons = []
        for _ in range(2):
            held = await ws.shell("rm -f /data/x")
            assert held.refusal is not None
            assert held.refusal.kind == "pending"
            (record,) = ws.decisions.pending()
            reasons.append(record.reason)
            await ws.decisions.answer(record.id, Outcome.ALLOW)
        assert reasons == ["removal", "anything"]
        assert (await ws.shell("rm -f /data/x")).exit_code == 0
    finally:
        await ws.close()


class AfterCommands(Policy):
    def __init__(self) -> None:
        self.seen: list[CommandResultContext] = []

    async def post_command(self, ctx: CommandResultContext) -> Action | None:
        self.seen.append(ctx)
        return None


@pytest.mark.asyncio
async def test_post_command_sees_each_command_once_with_its_result():
    # Once per command, after it ran: the exit code is final even for a
    # command whose status settles as its output drains (grep).
    policy = AfterCommands()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("echo hit > /data/x")
        ws.policies.add(policy)
        await ws.shell("grep miss /data/x; cat /data/none")
        assert [(c.command, c.exit_code) for c in policy.seen] == [
            ("grep", 1),
            ("cat", 1),
        ]
        assert "No such file or directory" in policy.seen[1].stderr
    finally:
        await ws.close()


class NoVaultShown(Policy):
    async def post_command(self, ctx: CommandResultContext) -> Action | None:
        if any(r["path"].startswith("/data/vault/") for r in ctx.records):
            return Deny("vault reads need an operator")
        return None


@pytest.mark.asyncio
async def test_post_command_reads_the_files_its_command_read():
    # cat reads as its output is pulled, after it returned: the records
    # are its own all the same, and the command reading them is not
    # charged with them.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /data/vault && echo k > /data/vault/k")
        ws.policies.add(NoVaultShown())
        out = await ws.shell("cat /data/vault/k && echo next")
        assert (out.exit_code, out.stdout) == (126, b"k\n")
        piped = await ws.shell("cat /data/vault/k | cat")
        assert (piped.exit_code, piped.stderr) == (
            0,
            b"cat: Permission denied\n",
        )
    finally:
        await ws.close()


class AccountsAtClose(RAMVFS):
    """Streams a file a little at a time and records what a read moved
    when its stream closes, as a backend that learns it at the end does."""

    caches_reads = False

    def read(self, path: PathSpec, offset: int = 0, size: int | None = None):
        if offset or size is not None:
            return super().read(path, offset, size)
        return self._chunks(
            path, self.accessor.store.files[norm(path.vfs_path)]
        )

    async def _chunks(self, path: PathSpec, data: bytes):
        timer = observe_context.start_op()
        sent = 0
        try:
            for start in range(0, len(data), 1024):
                chunk = data[start : start + 1024]
                sent += len(chunk)
                yield chunk
        finally:
            observe_context.record("read", path.virtual, "s3", sent, timer)


class RecordsByCommand(Policy):
    def __init__(self) -> None:
        self.seen: dict[str, list[dict]] = {}

    async def post_command(self, ctx: CommandResultContext) -> Action | None:
        self.seen[ctx.command] = list(ctx.records)
        return None


@pytest.mark.asyncio
async def test_a_stream_its_reader_stops_early_closes_as_its_command():
    # head pulls cat's output after cat returned and stops after a line:
    # the read is cat's, and so is the record its backend makes as the
    # stream closes, so head is charged with nothing.
    ws = Workspace({"/data/": AccountsAtClose()}, mode=MountMode.WRITE)
    try:
        big = b"".join(b"line %d\n" % i for i in range(20000))
        await ws.vfs.write("/data/big", big)
        policy = RecordsByCommand()
        ws.policies.add(policy)
        out = await ws.shell("cat /data/big | head -1")
        assert (out.exit_code, await out.materialize_stdout()) == (
            0,
            b"line 0\n",
        )
        (read,) = policy.seen["cat"]
        assert (read["op"], read["path"]) == ("read", "/data/big")
        assert 0 < read["bytes"] < len(big)
        assert policy.seen["head"] == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_once_nod_lasts_while_the_line_streams_and_no_longer():
    # The approved retry opens /data/b only once /data/a is drained, after
    # the line returned its output: the nod still covers it. The run
    # after asks again.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.vfs.write("/data/a", b"a\n" * 50000)
        await ws.vfs.write("/data/b", b"b\n" * 3)
        ws.create_session(
            "agent",
            profile={
                "commands": {"ask": [{"commands": {"cat": ["/data/b"]}}]}
            },
        )
        line = "cat /data/a /data/b | tail -c 4"
        held = await ws.shell(line, session_id="agent")
        assert held.refusal is not None and held.refusal.kind == "pending"
        (nod,) = ws.decisions.pending()
        await ws.decisions.answer(nod.id, Outcome.ALLOW)
        out = await ws.shell(line, session_id="agent")
        assert (out.exit_code, await out.materialize_stdout()) == (
            0,
            b"b\nb\n",
        )
        again = await ws.shell(line, session_id="agent")
        assert again.refusal is not None and again.refusal.kind == "pending"
    finally:
        await ws.close()


class AskBigReads(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.call.name == "read" and ctx.path.virtual == "/data/big":
            return Ask("big read")
        return None


@pytest.mark.asyncio
async def test_a_once_nod_covers_one_streamed_read_however_far_it_is_pulled():
    ws = Workspace({"/data/": AccountsAtClose()}, mode=MountMode.WRITE)
    try:
        await ws.vfs.write("/data/big", b"x" * 10000)
        ws.policies.add(AskBigReads())
        with pytest.raises(PolicyDenied) as held:
            await ws.vfs.read("/data/big", stream=True)
        await ws.decisions.answer(held.value.refusal.ask_id, Outcome.ALLOW)
        stream = await ws.vfs.read("/data/big", stream=True)
        assert len(await anext(stream)) == 1024
        await stream.aclose()
        with pytest.raises(PolicyDenied) as again:
            await ws.vfs.read("/data/big", stream=True)
        assert again.value.refusal.kind == "pending"
    finally:
        await ws.close()


class GuardVars(Policy):
    def __init__(self) -> None:
        self.seen: list[SessionResultContext] = []

    async def post_session(self, ctx: SessionResultContext) -> Action | None:
        self.seen.append(ctx)
        if ctx.key != "A":
            return None
        if ctx.value == "2" or ctx.verb == "unset":
            return Deny("frozen")
        return None


@pytest.mark.asyncio
async def test_a_post_session_deny_puts_the_old_value_back():
    policy = GuardVars()
    ws = Workspace({"/data/": RAMVFS()}, policies=[policy])
    try:
        assert (await ws.shell("export A=1")).exit_code == 0
        assert policy.seen[-1].old is None
        refused = await ws.shell("export A=2")
        assert refused.exit_code == 1
        assert policy.seen[-1].old == "1"
        assert (await ws.shell("echo $A")).stdout == b"1\n"
        assert (await ws.shell("unset A")).exit_code == 1
        assert (await ws.shell("echo $A")).stdout == b"1\n"
    finally:
        await ws.close()


class ReadsAround(Policy):
    def __init__(self) -> None:
        self.seen: list[tuple[str, str | None, bytes, bool]] = []
        self.refused: list[str] = []

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command != "echo":
            return None
        assert ctx.session is not None
        assert ctx.vfs is not None
        self.seen.append(
            (
                ctx.session.cwd(),
                ctx.session.get("TEAM"),
                await ctx.vfs.read("/data/owner.txt"),
                ctx.vfs.is_mount("/data"),
            )
        )
        try:
            await ctx.vfs.write("/data/owner.txt", b"me\n")
        except OSError as exc:
            self.refused.append(errno.errorcode[exc.errno or 0])
        try:
            await ctx.session.set("TEAM", "me")
        except OSError as exc:
            self.refused.append(errno.errorcode[exc.errno or 0])
        return None


@pytest.mark.asyncio
async def test_a_method_reads_the_session_and_its_files_and_writes_nothing():
    reader = ReadsAround()
    recorder = OpRecorder()
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[reader, recorder],
    )
    try:
        await ws.vfs.write("/data/owner.txt", b"core\n")
        await ws.shell("cd /data; export TEAM=core")
        recorder.asked.clear()
        assert (await ws.shell("echo hi")).stdout == b"hi\n"
        assert reader.seen == [("/data", "core", b"core\n", True)]
        assert reader.refused == ["EROFS", "EACCES"]
        # The method's own read is judged by the rules alone: no user
        # pre_vfs runs again for it.
        assert recorder.asked == []
        assert await ws.vfs.read("/data/owner.txt") == b"core\n"
        assert (await ws.shell("echo $TEAM")).stdout == b"core\n"
        # explain walks the `cd` on a copy, and the method reads that copy.
        await ws.explain("cd /; echo hi")
        assert reader.seen[-1][0] == "/"
    finally:
        await ws.close()


class SeesCaller(Policy):
    def __init__(self) -> None:
        self.seen: list[tuple[str, str, str]] = []

    def _note(self, method: str, ctx) -> None:
        caller = ctx.caller
        assert caller is not None and caller.session is not None
        self.seen.append(
            (method, caller.session.session_id, caller.session.cwd)
        )

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "cat":
            self._note("pre_command", ctx)
        return None

    async def pre_vfs(self, ctx) -> Action | None:
        if ctx.path.virtual == "/data/owner.txt":
            self._note("pre_vfs", ctx)
        return None

    async def pre_session(self, ctx) -> Action | None:
        if ctx.key == "TEAM":
            self._note("pre_session", ctx)
        return None


# A program that denies with what its caller says: the same session id
# and working directory a coded policy reads off ``ctx.caller``.
CALLER = (
    CONTEXT
    + """
caller = ctx['caller']['session']
if ctx['command'] == 'cat':
    print(json.dumps({
        'kind': 'deny',
        'reason': caller['session_id'] + ' in ' + caller['cwd'],
    }))
"""
)


@pytest.mark.asyncio
async def test_a_method_sees_who_makes_the_call():
    seer = SeesCaller()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[seer])
    try:
        await ws.vfs.write("/data/owner.txt", b"core\n")
        seer.seen.clear()
        ws.create_session("agent")
        await ws.shell("cd /data", session_id="agent")
        await ws.shell("export TEAM=core", session_id="agent")
        await ws.shell("cat /data/owner.txt", session_id="agent")
        await Session(ws, "agent").vfs.read("/data/owner.txt")
        assert seer.seen == [
            ("pre_session", "agent", "/data"),
            ("pre_command", "agent", "/data"),
            ("pre_vfs", "agent", "/data"),
            ("pre_vfs", "agent", "/data"),
            ("pre_vfs", "agent", "/data"),
        ]
        await ws.explain("cat /data/owner.txt", session_id="agent")
        assert seer.seen[-1] == ("pre_command", "agent", "/data")
    finally:
        await ws.close()


class TouchesCaller(Policy):
    def __init__(self) -> None:
        self.refused: list[str] = []
        self.fields: set[str] = set()

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "cat":
            caller = ctx.caller
            assert caller is not None and caller.session is not None
            try:
                caller.session.cwd = "/"
            except FrozenInstanceError:
                self.refused.append("cwd")
            self.fields = {f.name for f in fields(caller)}
        return None


@pytest.mark.asyncio
async def test_a_method_cannot_change_the_session_through_its_caller():
    toucher = TouchesCaller()
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[toucher]
    )
    try:
        await ws.vfs.write("/data/owner.txt", b"core\n")
        ws.create_session("agent")
        await ws.shell("cd /data", session_id="agent")
        await ws.shell("cat /data/owner.txt", session_id="agent")
        assert toucher.refused == ["cwd"]
        assert toucher.fields == {"session"}
        assert (await ws.shell("pwd", session_id="agent")).stdout == (
            b"/data\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_program_sees_who_makes_the_call_as_a_coded_policy_does():
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=_scripted({"pre_command": CALLER}),
    )
    try:
        await ws.vfs.write("/data/owner.txt", b"core\n")
        ws.create_session("s", profile="release")
        await ws.shell("cd /data", session_id="s")
        denied = await ws.shell("cat owner.txt", session_id="s")
        assert denied.exit_code == 126
        assert denied.refusal is not None
        assert denied.refusal.reason == "s in /data"
    finally:
        await ws.close()


class SeeLine(Policy):
    def __init__(self) -> None:
        self.seen: list[ExecuteResultContext] = []

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        self.seen.append(ctx)
        return None


def _leaves(node: dict) -> list[tuple[str, int]]:
    children = node.get("children", [])
    if not children:
        return [(node.get("command", ""), node["exit_code"])]
    return [leaf for child in children for leaf in _leaves(child)]


def _records(node: dict) -> list[str]:
    mine = [r["path"] for r in node.get("records", [])]
    return mine + [p for c in node.get("children", []) for p in _records(c)]


@pytest.mark.asyncio
async def test_post_execute_sees_the_line_its_output_and_each_result():
    # A function hands back its last command's node, and grep's status
    # settles as its output drains: each node keeps its read and status.
    spy = SeeLine()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[spy])
    try:
        await ws.shell("cd /data; echo hi | cat; false")
        ctx = spy.seen[-1]
        assert ctx.line == "cd /data; echo hi | cat; false"
        assert [c.command for c in ctx.commands] == [
            "cd",
            "echo",
            "cat",
            "false",
        ]
        assert ctx.output == b"hi\n"
        assert ctx.exit_code == 1
        assert ctx.session is not None and ctx.session.cwd() == "/data"
        assert [name.split()[0] for name, _ in _leaves(ctx.results)] == [
            "cd",
            "echo",
            "cat",
            "false",
        ]
        assert _leaves(ctx.results)[-1][1] == 1
        await ws.shell("echo hit > /data/x")
        await ws.shell("f() { cat /data/x; }; f")
        assert "/data/x" in _records(spy.seen[-1].results)
        await ws.shell("grep hit /data/x; true")
        grep, _ = spy.seen[-1].results["children"]
        assert grep["exit_code"] == 0
        assert [r["path"] for r in grep["records"]] == ["/data/x"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_post_execute_sees_the_stderr_bc_writes_as_its_output_drains():
    # bc reports a runtime error and goes on, so the line exits 0 and
    # only bc's node says the division failed.
    spy = SeeLine()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[spy])
    try:
        run = await ws.shell("printf '1/0\\n2\\n' | bc")
        assert run.stdout == b"2\n"
        assert run.exit_code == 0
        _, bc = spy.seen[-1].results["children"]
        assert bc["command"] == "bc"
        assert bc["exit_code"] == 0
        assert bc["stderr"] == (
            "Runtime error (func=(main), adr=3): Divide by zero\n"
        )
    finally:
        await ws.close()


class SeeRoute(Policy):
    def __init__(self) -> None:
        self.seen: list[list[tuple[str, str, str | None]]] = []

    async def pre_execute(self, ctx: RouteContext) -> Action | None:
        self.seen.append(
            [
                (
                    c.command,
                    c.cwd,
                    c.session.cwd() if c.session is not None else None,
                )
                for c in ctx.commands
            ]
        )
        return None


@pytest.mark.asyncio
async def test_pre_execute_shows_a_nested_command_in_the_session_it_runs_in():
    # eval's line runs after its own cd: the command in it stands in
    # /data, while eval itself stands where the line was typed.
    spy = SeeRoute()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[spy])
    try:
        await ws.shell("eval 'cd /data; cat x'")
        assert spy.seen[-1] == [
            ("eval", "/", "/"),
            ("cd", "/", "/"),
            ("cat", "/data", "/data"),
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_route_policy_reads_the_session_as_data():
    seen: list[dict] = []

    def route(ctx: RouteContext) -> None:
        seen.append(script_context(ctx))
        return None

    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, route_policy=route
    )
    try:
        await ws.shell("cd /data; export TEAM=core")
        await ws.shell("echo hi")
        assert seen[-1]["cwd"] == "/data"
        assert seen[-1]["env"]["TEAM"] == "core"
        assert "/data" in seen[-1]["mounts"]
    finally:
        await ws.close()


class SeePrefix(Policy):
    def __init__(self, name: str = "GPU") -> None:
        self.name = name
        self.routed: list[tuple[str, str | None]] = []
        self.commanded: list[tuple[str, str | None]] = []

    async def pre_execute(self, ctx: RouteContext) -> Action | None:
        self.routed.extend(
            (c.command, c.session.get(self.name) if c.session else None)
            for c in ctx.commands
        )
        return None

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        assert ctx.session is not None
        self.commanded.append((ctx.command, ctx.session.get(self.name)))
        return None


@pytest.mark.asyncio
async def test_pre_execute_reads_a_commands_own_prefix_as_pre_command_will():
    # GPU=1 is the environment of echo alone: cat beside it and the
    # line's session never hold it.
    spy = SeePrefix()
    seen: list[dict] = []

    def route(ctx: RouteContext) -> None:
        seen.append(script_context(ctx))
        return None

    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        policies=[spy],
        route_policy=route,
    )
    try:
        await ws.shell("GPU=1 MODEL='a b' echo hi | cat")
        assert spy.routed == [("echo", "1"), ("cat", None)]
        assert sorted(spy.commanded) == sorted(spy.routed)
        echo, cat = seen[-1]["commands"]
        assert (echo["env"]["GPU"], echo["env"]["MODEL"]) == ("1", "a b")
        assert "GPU" not in cat["env"]
        assert "GPU" not in seen[-1]["env"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_env_s_command_is_read_in_the_environment_env_gives_it():
    spy = SeePrefix()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[spy])
    try:
        await ws.shell(
            "GPU=1 env -u GPU echo a; env GPU=2 echo b; GPU=3 env -i echo c"
        )
        assert spy.routed == [
            ("env", "1"),
            ("echo", None),
            ("env", None),
            ("echo", "2"),
            ("env", "3"),
            ("echo", None),
        ]
        assert sorted(spy.commanded, key=str) == sorted(spy.routed, key=str)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_env_i_brings_no_startup_variable_back():
    spy = SeePrefix("PWD")
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[spy])
    try:
        await ws.shell("env -i echo c")
        assert spy.routed == [("env", "/"), ("echo", None)]
        assert sorted(spy.commanded, key=str) == sorted(spy.routed, key=str)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_nested_shell_s_line_is_read_in_a_new_shell():
    pwd, gpu = SeePrefix("PWD"), SeePrefix()
    ws = Workspace(
        {"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[pwd, gpu]
    )
    try:
        await ws.shell("env -i bash -c 'echo a'")
        assert pwd.routed == [("env", "/"), ("bash", None), ("echo", "/")]
        await ws.shell("GPU=1")
        await ws.shell("bash -c 'echo b'")
        assert gpu.routed[-2:] == [("bash", "1"), ("echo", None)]
        for spy in (pwd, gpu):
            assert sorted(spy.commanded, key=str) == sorted(
                spy.routed, key=str
            )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_prefix_leaves_a_readonly_name_and_the_next_command_alone():
    spy = SeePrefix()
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE, policies=[spy])
    try:
        await ws.shell("readonly GPU=0")
        await ws.shell("GPU=1 cd /data; echo $GPU")
        assert spy.routed[-2:] == [("cd", "0"), ("echo", "0")]
        assert spy.commanded[-2:] == spy.routed[-2:]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_program_calls_the_workspaces_policy_functions(
    monkeypatch,
):
    monkeypatch.setenv("POLICY_DIRECTORY_TOKEN", "t0k")
    seen: list[tuple[str, str]] = []

    async def directory(command, token):
        seen.append((command, token))
        return command == "rm"

    source = """
import json, os
ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])
if await directory(ctx["command"], os.environ["TOKEN"]):
    print(json.dumps({"kind": "deny", "reason": os.environ["WHY"]}))
"""
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={
            "release": {
                "policy": {
                    "pre_command": [
                        {
                            "script": ScriptSource(source),
                            "runtime": "monty",
                            "env": {
                                "WHY": "directory says no",
                                "TOKEN": {
                                    "from": "env",
                                    "key": "POLICY_DIRECTORY_TOKEN",
                                },
                            },
                        }
                    ]
                }
            }
        },
        policy_functions={"directory": directory},
    )
    try:
        ws.create_session("s", profile="release")
        assert (await ws.shell("echo hi", session_id="s")).exit_code == 0
        refused = await ws.shell("rm /data/x", session_id="s")
        assert refused.refusal is not None
        assert refused.refusal.reason == "directory says no"
        assert seen == [("echo", "t0k"), ("rm", "t0k")]
    finally:
        await ws.close()


async def _directory(command):
    return command == "rm"


@pytest.mark.asyncio
async def test_a_copy_and_a_restore_keep_the_policy_functions(tmp_path):
    source = """
import json, os
ctx = json.loads(os.environ["MIRAGE_POLICY_CTX"])
if await directory(ctx["command"]):
    print(json.dumps({"kind": "deny", "reason": "directory says no"}))
"""
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={
            "release": {
                "policy": {
                    "pre_command": [
                        {"script": ScriptSource(source), "runtime": "monty"}
                    ]
                }
            }
        },
        policy_functions={"directory": _directory},
    )
    ws.create_session("s", profile="release")
    tar = tmp_path / "ws.tar"
    await ws.snapshot(tar)
    copied = await ws.copy()
    restored = await Workspace.load(
        tar, policy_functions={"directory": _directory}
    )
    try:
        for each in (copied, restored):
            refused = await each.shell("rm /data/x", session_id="s")
            assert refused.refusal is not None
            assert refused.refusal.reason == "directory says no"
    finally:
        for each in (ws, copied, restored):
            await each.close()
