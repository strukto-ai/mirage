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
import pytest_asyncio

from mirage import Session, Workspace
from mirage.policy import CommandContext, Deny, OpsContext, Policy
from mirage.policy.match import Outcome
from mirage.policy.types import Scope
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS

PROFILE = {
    "mounts": {"/data": "write", "/ro": "read"},
    "paths": {"hide": ["/data/vault"]},
    "commands": {
        "deny": [{"reason": "sealed", "paths": ["/data/sec/*"]}],
        "ask": [{"reason": "nod", "paths": ["/data/out/*"]}],
    },
}


@pytest_asyncio.fixture
async def ws():
    ws = Workspace(
        {"/data/": RAMVFS(), "/ro/": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.vfs.mkdir("/data/sec")
    await ws.vfs.write("/data/sec/k", b"key")
    await ws.vfs.symlink("/data/link", "/data/sec/k")
    ws.create_session("agent", profile=PROFILE)
    yield ws
    await ws.close()


@pytest.mark.asyncio
async def test_vfs_explains_each_op_as_the_door_answers(ws):
    explain = Session(ws, "agent").explain
    sealed = await explain.vfs.read("/data/sec/k")
    assert (sealed.call, sealed.outcome, sealed.source, sealed.error) == (
        "read",
        Outcome.DENY,
        "top",
        "EACCES",
    )
    assert sealed.refusal is not None and sealed.refusal.reason == "sealed"
    [answer] = sealed.answers
    assert isinstance(answer, Deny)
    assert (answer.reason, answer.policy) == ("sealed", "PermissionsPolicy")
    asked = await explain.vfs.write("/data/out/a", b"x")
    assert (asked.outcome, asked.error) == (Outcome.ASK, "EACCES")
    assert asked.refusal is not None and asked.refusal.kind == "pending"
    assert ws.decisions.pending("agent") == ()
    # The mode raises its own error, so no record rides it.
    read_only = await explain.vfs.mkdir("/ro/d")
    assert (read_only.error, read_only.refusal) == ("EROFS", None)
    assert read_only.answers[-1].policy == "MountModePolicy"
    free = await explain.vfs.write("/data/new", b"x")
    assert (free.outcome, free.error, free.answers) == (Outcome.ALLOW, "", ())
    # Nothing ran.
    assert not await ws.vfs.exists("/data/new")


@pytest.mark.asyncio
async def test_vfs_follows_the_doors_own_path(ws):
    explain = Session(ws, "agent").explain
    linked = await explain.vfs.read("/data/link")
    assert linked.refusal is not None
    assert (linked.paths, linked.error, linked.refusal.reason) == (
        ("/data/link",),
        "EACCES",
        "sealed",
    )
    moved = await explain.vfs.rename("/data/a", "/data/sec/b")
    assert moved.refusal is not None
    assert (moved.paths, moved.error, moved.refusal.reason) == (
        ("/data/a", "/data/sec/b"),
        "EACCES",
        "sealed",
    )


@pytest.mark.asyncio
async def test_a_hidden_path_explains_like_one_nothing_refuses(ws):
    explain = Session(ws, "agent").explain
    hidden = await explain.vfs.read("/data/vault/k")
    missing = await explain.vfs.read("/data/nothing")
    assert hidden == dataclasses.replace(missing, paths=("/data/vault/k",))
    assert (missing.outcome, missing.error) == (Outcome.ALLOW, "")
    exists = await explain.vfs.exists("/data/nothing")
    assert (exists.call, exists.paths) == ("exists", ("/data/nothing",))


@pytest.mark.asyncio
async def test_a_dry_run_leaves_the_drift_checks_pending(ws):
    ws._drift.queue("/data/sec/k", "fingerprint")
    await Session(ws, "agent").explain.vfs.read("/data/sec/k")
    assert ws._drift.pending


class _Flag(Policy):
    """Refuses writes while ``/data/flag`` reads ``closed``."""

    def __init__(self, ws: Workspace) -> None:
        self.ws = ws

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        if ctx.op != "write" or ctx.path.virtual == "/data/flag":
            return None
        flag = await self.ws.vfs.read("/data/flag")
        return Deny("closed") if flag == b"closed" else None


@pytest.mark.asyncio
async def test_a_policy_reads_for_real_while_it_decides(ws):
    await ws.vfs.write("/data/flag", b"closed")
    ws.policies.add(_Flag(ws))
    said = await Session(ws, "agent").explain.vfs.write("/data/new", b"x")
    assert (said.reason, said.answers) == (
        "closed",
        (Deny("closed", policy="_Flag"),),
    )


class _Busy(Policy):
    """Deciding a write to ``/data/new``, or the line ``ls /data/new``,
    reads an asked file as the agent and stamps one."""

    def __init__(self, ws: Workspace) -> None:
        self.ws = ws
        self.errors: list[int | None] = []

    async def _busy(self) -> None:
        try:
            await Session(self.ws, "agent").vfs.read("/data/out/q")
        except PermissionError as exc:
            self.errors.append(exc.errno)
        try:
            await self.ws.vfs.write("/data/stamp", b"seen")
        except PermissionError as exc:
            self.errors.append(exc.errno)

    async def pre_ops(self, ctx: OpsContext) -> None:
        if ctx.op == "write" and ctx.path.virtual == "/data/new":
            await self._busy()
        return None

    async def pre_command(self, ctx: CommandContext) -> None:
        if ctx.command == "ls":
            await self._busy()
        return None


@pytest.mark.asyncio
async def test_a_policy_changes_nothing_while_it_decides(ws):
    busy = _Busy(ws)
    ws.policies.add(busy)
    await Session(ws, "agent").explain.vfs.write("/data/new", b"x")
    assert busy.errors == [errno.EACCES, errno.EROFS]
    assert ws.decisions.pending("agent") == ()
    assert not await ws.vfs.exists("/data/stamp")


@pytest.mark.asyncio
async def test_a_line_s_policies_change_nothing_either(ws):
    busy = _Busy(ws)
    ws.policies.add(busy)
    await Session(ws, "agent").explain.shell("ls /data/new")
    assert busy.errors == [errno.EACCES, errno.EROFS]
    assert ws.decisions.pending("agent") == ()
    assert not await ws.vfs.exists("/data/stamp")


@pytest.mark.asyncio
async def test_a_standing_approval_covers_a_deciding_read(ws):
    await ws.vfs.mkdir("/data/out")
    await ws.vfs.write("/data/out/q", b"q")
    with pytest.raises(PermissionError):
        await Session(ws, "agent").vfs.read("/data/out/q")
    [asked] = ws.decisions.pending("agent")
    await ws.decisions.answer(asked.id, Outcome.ALLOW, Scope.SESSION)
    busy = _Busy(ws)
    ws.policies.add(busy)
    await Session(ws, "agent").explain.vfs.write("/data/new", b"x")
    assert busy.errors == [errno.EROFS]


@pytest.mark.asyncio
async def test_a_line_s_policy_reads_as_the_running_line_does(ws):
    await ws.vfs.mkdir("/data/out")
    await ws.vfs.write("/data/out/q", b"q")
    with pytest.raises(PermissionError):
        await Session(ws, "agent").vfs.read("/data/out/q")
    [asked] = ws.decisions.pending("agent")
    await ws.decisions.answer(asked.id, Outcome.ALLOW, Scope.SESSION)
    busy = _Busy(ws)
    ws.policies.add(busy)
    # Inside a line an ask refuses like a deny, approved or not.
    await Session(ws, "agent").shell("ls /data/new")
    assert set(busy.errors) == {errno.EACCES}
    busy.errors.clear()
    await ws.vfs.unlink("/data/stamp")
    await Session(ws, "agent").explain.shell("ls /data/new")
    assert busy.errors == [errno.EACCES, errno.EROFS]
