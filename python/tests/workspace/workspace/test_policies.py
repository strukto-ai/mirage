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

from mirage import Action, CommandContext, Deny, GuardSpec, Policy, Workspace
from mirage.policy import ExecuteResultContext, OpsContext, OpsResultContext
from mirage.resource.ram import RAMResource
from mirage.types import Limit, MountMode, OnExceed


class NoInterpreters(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "python3":
            return Deny("python3: interpreters are off\n")
        return None


@pytest.mark.asyncio
async def test_workspace_guards_refuse_before_backend_io():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   guards=[
                       GuardSpec(reason="production data is protected",
                                 commands=("rm", ),
                                 paths=("/data/prod/*", ))
                   ])
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.ops.write("/data/prod/x.txt", b"keep\n")
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
        assert result.exit_code == 1
        assert result.stderr == b"python3: interpreters are off\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_policies_constructor_param_accepts_instances():
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   policies=[NoInterpreters()])
    try:
        result = await ws.execute("python3 -c 'print(1)'")
        assert result.exit_code == 1
        assert result.stderr == b"python3: interpreters are off\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_guards_cover_shell_builtins_and_namespace_routes():
    # source is a dispatch-level shell builtin and touch is
    # namespace-routed; neither reaches handle_command, so this pins
    # the hook at the dispatch chokepoint.
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   guards=[
                       GuardSpec(reason="disabled", commands=("source", )),
                       GuardSpec(reason="frozen",
                                 commands=("touch", ),
                                 paths=("/data/prod/*", )),
                   ])
    try:
        result = await ws.execute("source /data/setup.sh")
        assert result.exit_code == 1
        assert result.stderr == b"source: disabled\n"
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
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   guards=[
                       GuardSpec(reason="prod is protected",
                                 commands=("shuf", ),
                                 paths=("/data/prod/*", ))
                   ])
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
            return Deny("prod is read-only\n")
        return None


@pytest.mark.asyncio
async def test_path_guards_hold_at_the_programmatic_door():
    # ws.ops is the same seam FUSE comes through; a path-only guard
    # must refuse it, not just shell commands (#675).
    ws = Workspace({"/data/": RAMResource()},
                   mode=MountMode.WRITE,
                   guards=[
                       GuardSpec(reason="prod is protected",
                                 paths=("/data/prod/*", ))
                   ])
    try:
        await ws.execute("mkdir -p /data/other")
        await ws.ops.write("/data/other/ok.txt", b"fine\n")
        with pytest.raises(PermissionError) as excinfo:
            await ws.ops.write("/data/prod/x.txt", b"nope\n")
        assert excinfo.value.errno == errno.EACCES
        assert "prod is protected" in str(excinfo.value)
        with pytest.raises(PermissionError):
            await ws.ops.read("/data/prod/x.txt")
    finally:
        await ws.close()


class SuppressProdWrites(Policy):

    async def post_ops(self, ctx: OpsResultContext) -> Action | None:
        if ctx.write and ctx.path.virtual.startswith("/data/prod/"):
            return Deny("write suppressed\n")
        return None


@pytest.mark.asyncio
async def test_touch_on_an_existing_file_is_a_write_at_the_op_door():
    # touch on an existing file mutates via setattr, not create; the
    # write classification must cover that op too.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /data/prod")
        await ws.ops.write("/data/prod/x.txt", b"keep\n")
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
            await ws.ops.write("/data/prod/x.txt", b"data\n")
        assert any(r.op == "write" for r in ws.ops.records)
        assert await ws.ops.read("/data/prod/x.txt") == b"data\n"
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
        await ws.ops.write("/data/big.txt", b"1\n2\n3\n4\n5\n")
        r = await ws.execute("cat /data/big.txt")
        assert (await r.stdout_str()).count("\n") == 2
        assert "output truncated" in (await r.stderr_str())
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_user_limit_policy_caps_op_reads():
    # A post_ops Limit bounds the programmatic door too: ws.ops (and
    # FUSE behind it) serve capped bytes.
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(CapReadBytes())
        await ws.ops.write("/data/f.txt", b"hello world")
        assert await ws.ops.read("/data/f.txt") == b"hell"
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
            return Deny("reads are suppressed\n")
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
        await ws.ops.write("/data/big.txt", b"1\n2\n3\n4\n5\n")
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
        await ws.ops.write("/data/f.txt", b"hello world\n")
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
        await ws.ops.write("/data/f.txt", b"hello world")
        with pytest.raises(PermissionError) as excinfo:
            await ws.ops.read("/data/f.txt")
        assert "reads are suppressed" in str(excinfo.value)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_raising_post_execute_policy_fails_the_line_closed():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    try:
        ws.policies.add(Boom())
        r = await ws.execute("echo hi")
        assert r.exit_code == 1
        err = await r.stderr_str()
        assert "Boom" in err
        assert "boom" in err
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
        await ws.ops.write("/data/f.txt", b"a\nb\n")
        await ws.execute("cat /data/f.txt | wc -l")
        await ws.execute("cat /data/f.txt ; head -n 1 /data/f.txt")
        await ws.execute("false || cat /data/f.txt")
        assert spy.seen == ["wc", "head", "cat"]
    finally:
        await ws.close()
