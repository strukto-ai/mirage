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

from mirage import Action, CommandContext, Deny, Policy, Workspace
from mirage.commands.errors import LimitExceededError
from mirage.io import IOResult
from mirage.policy import (CommandRule, ExecuteResultContext, OpsContext,
                           OpsResultContext, PolicyError)
from mirage.policy.profile import ProfilePolicy, SessionProfile
from mirage.resource.ram import RAMResource
from mirage.runtime.types import ScriptSource
from mirage.types import Limit, MountMode, OnExceed, Refusal

from mirage.policy.profile import (  # isort: skip
    CommandsBlock, PathsBlock)


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
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
        profiles=_profile(commands=CommandsBlock(
            deny=(CommandRule(reason="production data is protected",
                              commands=("rm", ),
                              paths=("/data/prod/*", )), ))),
    )
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/x.txt", b"keep\n")
        result = await ws.execute("rm /data/prod/x.txt")
        assert result.exit_code == 1
        assert result.stderr == (b"rm: /data/prod/x.txt: "
                                 b"production data is protected\n")
        out = await ws.execute("cat /data/prod/x.txt")
        assert out.stdout == b"keep\n"
        ok = await ws.execute("rm -f /data/prod/../other.txt 2>/dev/null; "
                              "echo done")
        assert b"done" in ok.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policies_add_wins_over_runtime_placement():
    # python3 is runtime-bound in the default world; the pre_command
    # hook fires ahead of runtime resolution, so the refusal wins.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(NoInterpreters())
        result = await ws.execute("python3 -c 'print(1)'")
        # A whole-command refusal is bash's "found but may not run".
        assert result.exit_code == 126
        assert result.stderr == b"python3: Permission denied\n"
        # The reason rides beside the GNU line, not inside it.
        assert result.refusal == Refusal(kind="deny",
                                         reason="interpreters are off",
                                         policy="NoInterpreters")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policies_constructor_param_accepts_instances():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   policies=[NoInterpreters()])
    try:
        result = await ws.execute("python3 -c 'print(1)'")
        assert result.exit_code == 126
        assert result.stderr == b"python3: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_guards_cover_shell_builtins_and_namespace_routes():
    # source is a dispatch-level shell builtin and touch is
    # namespace-routed; neither reaches handle_command, so this pins
    # the hook at the dispatch chokepoint.
    ws = Workspace(
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
        profiles=_profile(commands=CommandsBlock(deny=(
            CommandRule(reason="disabled", commands=("source", )),
            CommandRule(reason="frozen",
                        commands=("touch", ),
                        paths=("/data/prod/*", )),
        ))),
    )
    try:
        result = await ws.execute("source /data/setup.sh")
        assert result.exit_code == 126
        assert result.stderr == b"source: Permission denied\n"
        assert result.refusal == Refusal(kind="deny",
                                         reason="disabled",
                                         policy="PermissionsPolicy")
        result = await ws.execute("touch /data/prod/x")
        assert result.exit_code == 1
        assert b"frozen" in result.stderr
        ok = await ws.execute("touch /data/dev-x && echo done")
        assert b"done" in ok.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_guards_cover_path_valued_flags():
    # shuf discovers its output path from -o, not a positional operand;
    # the policy context must include flag-valued paths.
    ws = Workspace(
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
        profiles=_profile(commands=CommandsBlock(
            deny=(CommandRule(reason="prod is protected",
                              commands=("shuf", ),
                              paths=("/data/prod/*", )), ))),
    )
    try:
        await ws.execute("mkdir -p /data/prod")
        result = await ws.execute("shuf -e a -o /data/prod/out")
        assert result.exit_code == 1
        assert b"prod is protected" in result.stderr
        listing = await ws.execute("ls /data/prod")
        assert b"out" not in listing.stdout
    finally:
        await ws.close()


class ReadOnlyProd(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Deny("prod is read-only")
        return None


@pytest.mark.asyncio
async def test_path_guards_hold_at_the_programmatic_door():
    # ws.fs is the same seam FUSE comes through; a path-only guard
    # must refuse it, not just shell commands (#675).
    ws = Workspace(
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
        profiles=_profile(commands=CommandsBlock(deny=(
            CommandRule(reason="prod is protected", paths=(
                "/data/prod/*", )), ))),
    )
    try:
        await ws.execute("mkdir -p /data/other")
        await ws.fs.write("/data/other/ok.txt", b"fine\n")
        with pytest.raises(PermissionError) as excinfo:
            await ws.fs.write("/data/prod/x.txt", b"nope\n")
        assert excinfo.value.errno == errno.EACCES
        assert "prod is protected" in str(excinfo.value)
        with pytest.raises(PermissionError):
            await ws.fs.read("/data/prod/x.txt")
    finally:
        await ws.close()


class SuppressProdWrites(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Deny("write suppressed")
        return None


@pytest.mark.asyncio
async def test_touch_on_an_existing_file_is_a_write_at_the_op_door():
    # touch on an existing file mutates via setattr, not create; the
    # write classification must cover that op too.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/x.txt", b"keep\n")
        ws.policies.add(ReadOnlyProd())
        result = await ws.execute("touch /data/prod/x.txt")
        assert result.exit_code != 0
        assert b"Permission denied" in result.stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_post_ops_deny_still_records_the_completed_write():
    # A post deny suppresses the result, not the effect: the backend
    # already mutated, so observation and caches must reflect the op.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        ws.policies.add(SuppressProdWrites())
        with pytest.raises(PermissionError):
            await ws.fs.write("/data/prod/x.txt", b"data\n")
        assert any(r.op == "write" for r in ws.fs.records)
        assert await ws.fs.read("/data/prod/x.txt") == b"data\n"
    finally:
        await ws.close()


class SuppressProdReads(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if not ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Deny("no reads")
        return None


@pytest.mark.asyncio
async def test_post_ops_deny_records_the_bytes_a_denied_read_moved():
    # The suppressed result is the only place a read's byte count
    # lived, so without carrying it on the exception the record says
    # zero and network_bytes under-reports traffic that happened.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/x.txt", b"0123456789")
        ws.fs.records.clear()
        ws.policies.add(SuppressProdReads())
        with pytest.raises(PermissionError):
            await ws.fs.read("/data/prod/x.txt")
        reads = [r for r in ws.fs.records if r.op == "read"]
        assert len(reads) == 1
        assert reads[0].bytes == 10
    finally:
        await ws.close()


class CapProdReads(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if not ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Limit(max_bytes=3)
        return None


class CachingRAM(RAMResource):
    caches_reads = True
    name = "s3"


@pytest.mark.asyncio
async def test_a_capped_read_records_what_the_backend_moved():
    # A post_ops Limit truncates what the caller receives; the transfer
    # already happened, so recording the capped length would under-report
    # network_bytes by whatever the cap removed.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/x.txt", b"0123456789")
        ws.fs.records.clear()
        ws.policies.add(CapProdReads())
        assert await ws.fs.read("/data/prod/x.txt") == b"012"
        reads = [r for r in ws.fs.records if r.op == "read"]
        assert [r.bytes for r in reads] == [10]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_denied_warm_read_is_not_counted_as_network_traffic():
    # The deny suppresses a result the cache produced, so nothing
    # crossed the network; recording it against the backend would count
    # traffic that never happened.
    ws = Workspace({"/data/": CachingRAM()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/x.txt", b"0123456789")
        await ws.apply_io(
            IOResult(reads={"/data/prod/x.txt": b"0123456789"},
                     cache=["/data/prod/x.txt"]))
        ws.fs.records.clear()
        ws.policies.add(SuppressProdReads())
        with pytest.raises(PermissionError):
            await ws.fs.read("/data/prod/x.txt")
        rec = ws.fs.records[-1]
        assert rec.source == "ram"
        assert rec.is_cache is True
        assert ws.fs.network_bytes == 0
    finally:
        await ws.close()


class HardCapProdReads(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if not ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Limit(max_bytes=3, on_exceed=OnExceed.ERROR)
        return None


class ColdRemote(RAMResource):
    caches_reads = False
    name = "s3"


@pytest.mark.asyncio
async def test_a_hard_capped_read_records_what_the_backend_moved():
    # An ERROR-mode cap refuses the caller the bytes, but the backend
    # already moved them; dropping the record loses the whole transfer
    # rather than just truncating it.
    ws = Workspace({"/data/": ColdRemote()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/x.txt", b"0123456789")
        ws.fs.records.clear()
        ws.policies.add(HardCapProdReads())
        with pytest.raises(LimitExceededError):
            await ws.fs.read("/data/prod/x.txt")
        reads = [r for r in ws.fs.records if r.op == "read"]
        assert [(r.source, r.bytes) for r in reads] == [("s3", 10)]
        assert ws.fs.network_bytes == 10
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_hard_capped_warm_read_is_not_network_traffic():
    # Same refusal, but the cache produced the bytes, so the transfer
    # it stands for never happened.
    ws = Workspace({"/data/": CachingRAM()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/x.txt", b"0123456789")
        await ws.apply_io(
            IOResult(reads={"/data/prod/x.txt": b"0123456789"},
                     cache=["/data/prod/x.txt"]))
        ws.fs.records.clear()
        ws.policies.add(HardCapProdReads())
        with pytest.raises(LimitExceededError):
            await ws.fs.read("/data/prod/x.txt")
        rec = ws.fs.records[-1]
        assert rec.source == "ram"
        assert rec.is_cache is True
        assert ws.fs.network_bytes == 0
    finally:
        await ws.close()


class BrokenPostOps(Policy):

    async def post_ops(self, ctx: OpsResultContext):
        if ctx.write and ctx.path.virtual == "/data/prod/x.txt":
            return 42
        return None


@pytest.mark.asyncio
async def test_a_committed_write_is_recorded_when_bookkeeping_fails():
    # The backend applied the write, then a step after it (here an
    # invalid post_ops return, but any foreign bookkeeping error looks
    # the same) blew up. The error must propagate AND the transfer must
    # stay on the books: the door stamped the report at completion, so
    # the record does not depend on what kind of exception followed.
    ws = Workspace({"/data/": ColdRemote()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        ws.fs.records.clear()
        ws.policies.add(BrokenPostOps())
        with pytest.raises(PolicyError):
            await ws.fs.write("/data/prod/x.txt", b"123456")
        assert await ws.fs.read("/data/prod/x.txt") == b"123456"
        writes = [r for r in ws.fs.records if r.op == "write"]
        assert [(r.source, r.bytes) for r in writes] == [("s3", 6)]
        assert ws.fs.network_bytes >= 6
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_pre_ops_policy_holds_on_the_dispatcher_door():
    # touch routes through the shell's internal dispatcher, not
    # handle_command; a pre_ops-only policy must still refuse it.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(ReadOnlyProd())
        await ws.execute("mkdir -p /data/prod")
        result = await ws.execute("touch /data/prod/x")
        assert result.exit_code != 0
        assert b"Permission denied" in result.stderr
        ok = await ws.execute("touch /data/free && echo done")
        assert b"done" in ok.stdout
    finally:
        await ws.close()


class SealedPaths(Policy):

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        if not ctx.write and ctx.path.virtual == "/data/secret.txt":
            return Deny("secret is sealed")
        # The subtree spelling covers the root too: a native tree op
        # (rm_r) admits as one op on the root, per the pre_ops
        # docstring.
        if ctx.write and (ctx.path.virtual == "/data/prod"
                          or ctx.path.virtual.startswith("/data/prod/")):
            return Deny("prod is read-only")
        return None


@pytest.mark.asyncio
async def test_pre_ops_binds_op_doors_and_command_tier_io():
    # The documented boundary (Policy.pre_ops): coded op hooks fire at
    # the op doors AND for the backend I/O inside a mount command's
    # handler (with_policy_guard). Both tiers are pinned so a move of
    # the boundary is loud.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/secret.txt", b"sealed\n")
        await ws.fs.write("/data/prod/keep.txt", b"keep\n")
        ws.policies.add(SealedPaths())

        # The doors hold: the ops facade, and a dispatcher-routed
        # redirect write.
        with pytest.raises(PermissionError):
            await ws.fs.read("/data/secret.txt")
        redirect = await ws.execute("echo hi > /data/prod/new.txt")
        assert redirect.exit_code != 0

        # The command tier consults the same hooks: the read refuses
        # in the command's own voice and the deletion never lands.
        leak = await ws.execute("cat /data/secret.txt")
        assert leak.exit_code != 0
        assert leak.stdout in (None, b"")
        assert b"cat: /data/secret.txt: Permission denied" in leak.stderr
        removed = await ws.execute("rm /data/prod/keep.txt")
        assert removed.exit_code != 0
        assert b"cannot remove" in removed.stderr
        kept = await ws.execute("cat /data/prod/keep.txt")
        assert kept.exit_code == 0
        assert kept.stdout == b"keep\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_pre_ops_holds_walks_and_lazy_readers():
    # A walk is held per entry (GNU's unreadable-file shape: the other
    # entries still serve, stderr names the refused one), and a reader
    # the output pipeline drains after dispatch (head binds a lazy
    # stream) still answers through the wrap-time capture.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.fs.write("/data/secret.txt", b"sealed\n")
        await ws.fs.write("/data/ok.txt", b"has sealed word\n")
        ws.policies.add(SealedPaths())

        walked = await ws.execute("grep -r sealed /data")
        assert walked.exit_code == 2
        assert b"/data/ok.txt:has sealed word" in walked.stdout
        assert b"sealed\n" not in walked.stdout.replace(
            b"has sealed word\n", b"")
        assert b"grep: /data/secret.txt: Permission denied" in walked.stderr

        lazy = await ws.execute("head -c 3 /data/secret.txt")
        assert lazy.exit_code != 0
        assert b"head: /data/secret.txt: Permission denied" in lazy.stderr
        fine = await ws.execute("head -c 3 /data/ok.txt")
        assert fine.exit_code == 0
        assert fine.stdout == b"has"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_pre_ops_denied_entries_still_list_and_stat():
    # Presence facts stay unguarded on the command tier (mode-000
    # shape): a read-denied entry lists and stats, the read of it is
    # what fails.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.fs.write("/data/secret.txt", b"sealed\n")
        ws.policies.add(SealedPaths())
        listing = await ws.execute("ls -l /data")
        assert listing.exit_code == 0
        assert b"secret.txt" in listing.stdout
        found = await ws.execute("find /data -type f")
        assert found.exit_code == 0
        assert b"/data/secret.txt" in found.stdout
    finally:
        await ws.close()


class OpRecorder(Policy):

    def __init__(self) -> None:
        self.asked: list[tuple[str, str, bool]] = []

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        self.asked.append((ctx.op, ctx.path.virtual, ctx.write))
        return None


@pytest.mark.asyncio
async def test_shell_rm_r_admits_through_pre_ops():
    # The cascade asymmetry closed: an ops-door rmdir cascade always
    # admitted per deletion while a shell rm -r admitted nothing. The
    # shell tree removal now admits the op the backend performs (the
    # native rm_r here), and a write-deny refuses it outright.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod/sub")
        await ws.fs.write("/data/prod/a.txt", b"a\n")
        await ws.fs.write("/data/prod/sub/b.txt", b"b\n")
        rec = OpRecorder()
        ws.policies.add(rec)
        removed = await ws.execute("rm -r /data/prod")
        assert removed.exit_code == 0
        writes = [a for a in rec.asked if a[2]]
        assert ("rm_r", "/data/prod", True) in writes
    finally:
        await ws.close()

    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.fs.write("/data/prod/a.txt", b"a\n")
        ws.policies.add(SealedPaths())
        refused = await ws.execute("rm -r /data/prod")
        assert refused.exit_code != 0
        survives = await ws.execute("cat /data/prod/a.txt")
        assert survives.exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_find_delete_admits_each_deletion_exactly_once():
    # find's -delete admits the removal itself (in find's own refusal
    # voice) and suspends the delegated rm's slots, so a counting or
    # budget policy sees one deletion once, not twice.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/d")
        await ws.fs.write("/data/d/x.txt", b"x\n")
        rec = OpRecorder()
        ws.policies.add(rec)
        removed = await ws.execute("find /data/d -name x.txt -delete")
        assert removed.exit_code == 0
        gone = await ws.execute("cat /data/d/x.txt")
        assert gone.exit_code != 0
        writes = [a for a in rec.asked if a[1] == "/data/d/x.txt" and a[2]]
        assert writes == [("unlink", "/data/d/x.txt", True)]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_pre_ops_sees_the_session_on_the_command_tier():
    # OpsContext.session_id names the session on the command tier
    # exactly as at the op doors, including for a reader the pipeline
    # drains after dispatch (head), so a session-scoped policy holds on
    # both.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.fs.write("/data/ok.txt", b"fine\n")
        rec = SessionRecorder()
        ws.policies.add(rec)
        assert (await ws.execute("cat /data/ok.txt")).exit_code == 0
        assert (await ws.execute("head -c 3 /data/ok.txt")).exit_code == 0
        reads = [(op, sid) for op, path, sid in rec.asked
                 if path == "/data/ok.txt"]
        assert reads
        assert all(sid == ws.default_session_id for _, sid in reads)
    finally:
        await ws.close()


class SessionRecorder(Policy):

    def __init__(self) -> None:
        self.asked: list[tuple[str, str, str]] = []

    async def pre_ops(self, ctx: OpsContext) -> Action | None:
        self.asked.append((ctx.op, ctx.path.virtual, ctx.session_id))
        return None


class CapLines(Policy):

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_lines=2)


class CapReadBytes(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if ctx.op == "read":
            return Limit(max_bytes=4)
        return None


@pytest.mark.asyncio
async def test_user_limit_policy_caps_line_output():
    # A user Limit merges with the built-in cap (tightest wins) and
    # bounds what execute() returns.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapLines())
        await ws.fs.write("/data/big.txt", b"1\n2\n3\n4\n5\n")
        r = await ws.execute("cat /data/big.txt")
        assert (await r.stdout_str()).count("\n") == 2
        assert "output truncated" in (await r.stderr_str())
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_user_limit_policy_caps_op_reads():
    # A post_ops Limit bounds the programmatic door too: ws.fs (and
    # FUSE behind it) serve capped bytes.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapReadBytes())
        await ws.fs.write("/data/f.txt", b"hello world")
        assert await ws.fs.read("/data/f.txt") == b"hell"
    finally:
        await ws.close()


class CapBytesHard(Policy):

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        return Limit(max_bytes=4, on_exceed=OnExceed.ERROR)


class Boom(Policy):

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        raise RuntimeError("boom")


class DenyReads(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if ctx.op == "read":
            return Deny("reads are suppressed")
        return None


class SeeProducer(Policy):

    def __init__(self) -> None:
        self.seen: list[str] = []

    async def post_execute(self, ctx: ExecuteResultContext) -> Action | None:
        self.seen.append(ctx.producer.command)
        return None


@pytest.mark.asyncio
async def test_two_limit_policies_merge_to_the_tightest_end_to_end():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapLines())
        ws.policies.add(SuppressNothingCapThree())
        await ws.fs.write("/data/big.txt", b"1\n2\n3\n4\n5\n")
        r = await ws.execute("cat /data/big.txt")
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
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapBytesHard())
        await ws.fs.write("/data/f.txt", b"hello world\n")
        r = await ws.execute("cat /data/f.txt")
        assert r.exit_code == 1
        assert r.stdout is None or await r.stdout_str() == ""
        assert "output truncated" in (await r.stderr_str())
        ok = await ws.execute("echo ok")
        assert ok.exit_code == 0  # within the bound: no refusal
        assert await ok.stdout_str() == "ok\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_post_ops_deny_beats_a_limit():
    # A refusal suppresses the result; bounding it would be meaningless.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapReadBytes())
        ws.policies.add(DenyReads())
        await ws.fs.write("/data/f.txt", b"hello world")
        with pytest.raises(PermissionError) as excinfo:
            await ws.fs.read("/data/f.txt")
        assert "reads are suppressed" in str(excinfo.value)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_raising_post_execute_policy_fails_the_line_closed():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(Boom())
        r = await ws.execute("echo hi")
        assert r.exit_code == 126
        err = await r.stderr_str()
        assert err == "echo: Permission denied\n"
        assert r.refusal == Refusal(kind="failed",
                                    reason="Boom failed",
                                    policy="Boom")
        assert r.stdout is None or await r.stdout_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_post_execute_sees_the_rightmost_producer():
    # The provenance a policy reads follows shell semantics: the tail
    # of a pipe, the right side of `;` and `||`.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        spy = SeeProducer()
        ws.policies.add(spy)
        await ws.fs.write("/data/f.txt", b"a\nb\n")
        await ws.execute("cat /data/f.txt | wc -l")
        await ws.execute("cat /data/f.txt ; head -n 1 /data/f.txt")
        await ws.execute("false || cat /data/f.txt")
        # Builtins carry provenance too: a policy keyed on echo sees it.
        await ws.execute("echo hi")
        await ws.execute("cat /data/f.txt ; echo done")
        assert spy.seen == ["wc", "head", "cat", "echo", "echo"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_profile_hides_bind_every_session_including_the_default():
    ram = RAMResource()
    ws = Workspace({"/data/": ram},
                   mode=MountMode.WRITE,
                   profiles=_profile(paths=PathsBlock(hide=("/data/finance",
                                                            "*.key"))))
    try:
        await ws.execute("mkdir -p /data/finance /data/pub")
        await ws.fs.write("/data/pub/a.txt", b"a\n")
        await ws.fs.write("/data/pub/b.key", b"k\n")
        # The default session cannot see the bound hides ...
        listing = await ws.execute("ls /data /data/pub")
        assert b"finance" not in listing.stdout
        assert b"b.key" not in listing.stdout
        assert b"a.txt" in listing.stdout
        # ... and neither can one created later from the same profile.
        ws.create_session("late")
        gone = await ws.execute("cat /data/pub/b.key", session_id="late")
        assert gone.exit_code != 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_sections_hides_are_written_in_full():
    # The section's entries are absolute, checked at load time to lie
    # under the mount root. They used to be relative and joined onto the
    # root, which silently doubled a path already written in full
    # (`/repo/secret` under `/repo` became `/repo/repo/secret`).
    repo = RAMResource()
    other = RAMResource()
    ws = Workspace(
        {
            "/repo/": (repo, MountMode.WRITE),
            "/other/": (other, MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "mounts": {
                    "/repo": {
                        "paths": {
                            "hide": ["/repo/.env", "/repo/*.pem"]
                        }
                    }
                }
            }
        })
    try:
        await ws.execute("mkdir -p /repo/certs /other")
        await ws.fs.write("/repo/.env", b"S=1\n")
        await ws.fs.write("/repo/certs/k.pem", b"pem\n")
        await ws.fs.write("/repo/README", b"r\n")
        await ws.fs.write("/other/.env", b"visible\n")
        await ws.fs.write("/other/x.pem", b"visible\n")
        listing = await ws.execute("ls -a /repo /repo/certs /other")
        out = listing.stdout.decode()
        # The section reaches only under its own root, so the same two
        # names outside the mount are untouched.
        assert ".env" in out.split("/other:")[1]
        assert "x.pem" in out
        assert "k.pem" not in out
        assert "README" in out
        repo_part = out.split("/other:")[0]
        assert ".env" not in repo_part.replace("/repo/certs:", "")
        hidden = await ws.execute("cat /repo/.env")
        assert hidden.exit_code != 0
        shown = await ws.execute("cat /other/.env")
        assert shown.stdout == b"visible\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_bare_name_under_deny_refuses_with_the_default_reason():
    # The document's deny rules compile at construction; a bare string
    # is one command name with the default reason.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_profile(commands=CommandsBlock(deny=("shred", ))))
    try:
        result = await ws.execute("shred /data/x")
        assert result.exit_code == 126
        assert result.stderr == b"shred: Permission denied\n"
    finally:
        await ws.close()


# A per-command judge: deny cat under /data/sealed/ with a computed
# reason, take shred to the approval door, stay silent otherwise. A
# policy defines the hook it answers at, and answers with return.
JUDGE = """\
def pre_command(ctx):
    c = ctx['command']
    for p in c['paths']:
        if c['name'] == 'cat' and p.startswith('/data/sealed/'):
            return {'deny': 'sealed by ' + ctx['profile']}
    if c['name'] == 'shred':
        return {'ask': 'sign-off'}
    return None
"""

# A judge that reads what the operand holds, not what it is called:
# the shape a content policy takes when it is a program.
READER = """\
def pre_command(ctx):
    for p in ctx['command']['paths']:
        try:
            body = open(p).read()
        except OSError:
            continue
        if 'payload' in body:
            return {'ask': 'sign-off on payload'}
    return None
"""


def _scripted(source: str = JUDGE,
              runtime: str = "monty") -> dict[str, dict[str, object]]:
    """One profile named release with a policy and nothing else, so
    what runs is purely the policy's decision.

    Args:
        source (str): the policy program called per command.
        runtime (str): the engine it runs on.
    """
    return {
        "release": {
            "policy": {
                "script": ScriptSource(source),
                "runtime": runtime,
            },
        }
    }


@pytest.mark.asyncio
async def test_a_profile_script_judges_each_command():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted())
    try:
        await ws.execute("mkdir -p /data/sealed && echo k > /data/sealed/k")
        ws.create_session("s", profile="release")
        assert (await ws.execute("echo hi", session_id="s")).exit_code == 0
        denied = await ws.execute("cat /data/sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_script_reads_resolved_paths_not_typed_words():
    # `cd /data && cat sealed/k` names no /data/sealed word; the gate
    # hands the script the resolved operand, so the deny still lands.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted())
    try:
        ws.create_session("s", profile="release")
        denied = await ws.execute("cd /data && cat sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_script_only_profile_installs_everything():
    # No allow list, so nothing is hidden: a command no document names
    # runs whenever the script stays silent on it.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted())
    try:
        await ws.execute("echo x > /data/x")
        ws.create_session("s", profile="release")
        assert (await ws.execute("rm /data/x", session_id="s")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_document_may_ride_beside_the_script():
    # Optional, not required: a profile stating both keeps the allow
    # list's hiding, and the script adds its verdicts beside it.
    profiles = _scripted()
    profiles["release"]["commands"] = {"allow": ["ls", "cat", "echo"]}
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=profiles)
    try:
        ws.create_session("s", profile="release")
        hidden = await ws.execute("rm /data/x", session_id="s")
        assert hidden.exit_code == 127
        denied = await ws.execute("cat /data/sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_ask_it_computed_takes_the_approval_door():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted())
    try:
        ws.create_session("s", profile="release")
        held = await ws.execute("shred /data/x", session_id="s")
        assert held.exit_code == 126
        assert held.stderr is not None
        assert held.stderr == b"shred: Permission denied\n"
        assert held.refusal is not None
        assert (held.refusal.kind, held.refusal.reason) == ("pending",
                                                            "sign-off")
        assert held.refusal.ask_id
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_script_reads_what_the_line_names():
    # Content, not names: the script opens each operand through the
    # same door an agent's program would, so it can ask about what a
    # file holds. A directory operand is not its business, and a file
    # without the marker runs.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted(READER))
    try:
        await ws.execute("mkdir -p /data/in && "
                         "printf 'subject: invoice\\n\\na payload\\n' "
                         "> /data/in/mail.txt && "
                         "echo plain > /data/in/note.txt")
        ws.create_session("s", profile="release")
        held = await ws.execute("cat /data/in/mail.txt", session_id="s")
        assert held.exit_code == 126
        assert held.refusal is not None
        assert (held.refusal.kind,
                held.refusal.reason) == ("pending", "sign-off on payload")
        plain = await ws.execute("cat /data/in/note.txt", session_id="s")
        assert plain.exit_code == 0
        assert (await ws.execute("ls /data/in", session_id="s")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_scripted_profile_leaves_other_sessions_alone():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted())
    try:
        await ws.execute("mkdir -p /data/sealed && echo k > /data/sealed/k")
        ws.create_session("s", profile="release")
        read = await ws.execute("cat /data/sealed/k")
        assert read.exit_code == 0
        assert read.stdout == b"k\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_scripted_default_profile_shapes_the_default_session():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted(),
                   profile="release")
    try:
        assert (await ws.execute("echo hi")).exit_code == 0
        denied = await ws.execute("cat /data/sealed/k")
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
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   runtimes=["vfs"],
                   profiles=_scripted())
    try:
        ws.create_session("s", profile="release")
        denied = await ws.execute("cat /data/sealed/k", session_id="s")
        assert denied.exit_code == 126
        assert denied.stderr == b"cat: Permission denied\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_broken_script_fails_closed_per_command():
    # Silence on failure would run exactly the commands the script
    # existed to judge.
    ws = Workspace(
        {"/data/": RAMResource()},
        mode=MountMode.WRITE,
        profiles=_scripted(
            source="def pre_command(ctx):\n    raise ValueError('boom')"))
    try:
        ws.create_session("s", profile="release")
        refused = await ws.execute("echo hi", session_id="s")
        assert refused.exit_code == 126
        assert refused.stderr == b"echo: Permission denied\n"
        assert refused.refusal is not None
        assert "profile 'release' policy failed" in refused.refusal.reason
        assert (await ws.execute("echo hi")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_engine_that_cannot_evaluate_fails_closed():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted(runtime="local"))
    try:
        ws.create_session("s", profile="release")
        refused = await ws.execute("echo hi", session_id="s")
        assert refused.exit_code == 126
        assert refused.stderr == b"echo: Permission denied\n"
        assert refused.refusal is not None
        assert "cannot evaluate one" in refused.refusal.reason
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_policy_states_its_runtime():
    with pytest.raises(ValueError, match="runtime"):
        Workspace(
            {"/data/": RAMResource()},
            mode=MountMode.WRITE,
            profiles={"release": {
                "policy": {
                    "script": ScriptSource(JUDGE)
                }
            }})


def test_the_old_script_and_runtime_keys_are_told_the_new_block():
    # Shipped first as `script` with `runtime` beside it, a word for
    # what the file is rather than what it does and an engine that read
    # as the profile's own; the refusal says where they went.
    with pytest.raises(ValueError, match="now one policy block"):
        Workspace({"/data/": RAMResource()},
                  mode=MountMode.WRITE,
                  profiles={
                      "release": {
                          "script": ScriptSource(JUDGE),
                          "runtime": "monty",
                      }
                  })


@pytest.mark.asyncio
async def test_a_policy_defining_no_hook_fails_closed():
    # A verdict as a bare last expression was the old contract; a policy
    # defines the hooks it answers at, and a program defining none is
    # refused at every door rather than read for a value it never meant.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted(source="None"))
    try:
        ws.create_session("s", profile="release")
        refused = await ws.execute("echo hi", session_id="s")
        assert refused.exit_code == 126
        assert refused.refusal is not None
        assert refused.refusal.reason == (
            "profile 'release' policy defines no hook: pre_command, pre_ops "
            "or pre_session")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_inline_document_may_not_add_a_policy():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        with pytest.raises(PolicyError, match="not a policy"):
            ws.create_session(
                "s",
                permissions=SessionProfile(policy=ProfilePolicy(
                    script=ScriptSource(JUDGE), runtime="monty")))
    finally:
        await ws.close()


# A program at the op and session doors and nowhere else: writes under
# /data/frozen are refused, so is an AWS_* variable, and a command is
# never judged.
GATES = """\
def pre_ops(ctx):
    op = ctx['op']
    if op['write'] and op['path'].startswith('/data/frozen/'):
        return {'deny': 'frozen by ' + ctx['profile']}
    return None

def pre_session(ctx):
    if ctx['write']['key'].startswith('AWS_'):
        return {'deny': 'credentials are set by the operator'}
    return None
"""

# The content judge with an op hook beside it: its own reads have to
# pass the door its pre_ops guards.
READER_AND_GATE = READER + """
def pre_ops(ctx):
    op = ctx['op']
    if op['write'] and op['path'].startswith('/data/frozen/'):
        return {'deny': 'frozen'}
    return None
"""


@pytest.mark.asyncio
async def test_a_profile_policy_judges_the_op_door():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted(GATES))
    try:
        await ws.execute("mkdir -p /data/frozen && echo keep > /data/frozen/k")
        ws.create_session("s", profile="release")
        # No command hook, so a command is silence; a read is not a write.
        assert (await ws.execute("echo hi", session_id="s")).exit_code == 0
        read = await ws.execute("cat /data/frozen/k", session_id="s")
        assert read.exit_code == 0
        assert read.stdout == b"keep\n"
        refused = await ws.execute("echo x > /data/frozen/f", session_id="s")
        assert refused.exit_code == 1
        assert b"Permission denied" in refused.stderr
        removed = await ws.execute("rm /data/frozen/k", session_id="s")
        assert removed.exit_code == 1
        assert b"Permission denied" in removed.stderr
        assert (await ws.execute("cat /data/frozen/k")).stdout == b"keep\n"
        # Another session is not judged by it.
        assert (await ws.execute("echo x > /data/frozen/f")).exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profile_policy_judges_the_session_door():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted(GATES))
    try:
        ws.create_session("s", profile="release")
        refused = await ws.execute("export AWS_SECRET=x", session_id="s")
        assert refused.exit_code == 1
        assert refused.stderr == b"credentials are set by the operator\n"
        landed = await ws.execute("export SAFE=1 && echo $SAFE",
                                  session_id="s")
        assert landed.exit_code == 0
        assert landed.stdout == b"1\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_policys_own_read_passes_the_door_its_op_hook_guards():
    # pre_command opens the operand through the workspace's door while
    # pre_ops stands at it: the read is the policy's own and is let
    # through rather than re-entering the evaluation waiting on it, so
    # the content verdict lands and the op hook still refuses a write.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   profiles=_scripted(READER_AND_GATE))
    try:
        await ws.execute("mkdir -p /data/in && printf 'subject: invoice\\n\\n"
                         "a payload\\n' > /data/in/mail.txt && "
                         "echo plain > /data/in/note.txt")
        ws.create_session("s", profile="release")
        held = await ws.execute("cat /data/in/mail.txt", session_id="s")
        assert held.exit_code == 126
        assert held.refusal is not None
        assert held.refusal.kind == "pending"
        assert held.refusal.reason == "sign-off on payload"
        assert (await ws.execute("cat /data/in/note.txt",
                                 session_id="s")).exit_code == 0
        refused = await ws.execute("echo x > /data/frozen/f", session_id="s")
        assert refused.exit_code == 1
        assert b"Permission denied" in refused.stderr
    finally:
        await ws.close()
