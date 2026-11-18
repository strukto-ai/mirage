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
import pytest_asyncio

from mirage import Session, Workspace
from mirage.policy import CommandContext, Deny, Policy, VfsContext
from mirage.policy.match import Outcome
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS

PROFILE = {
    "mounts": {"/data": "write", "/ro": "read"},
    "paths": {"hide": ["/data/vault"]},
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
async def test_a_dry_run_leaves_the_drift_checks_pending(ws):
    ws._drift.queue("/data/sec/k", "fingerprint")
    await Session(ws, "agent").explain.vfs.read("/data/sec/k")
    assert ws._drift.pending


@pytest.mark.asyncio
async def test_a_mkdir_on_a_read_only_mount_explains_the_mode():
    # The run answers from a name lookup; a dry run looks nothing up and
    # explains the mode's refusal.
    with Workspace({"/ro": (RAMVFS(), MountMode.READ)}) as ws:
        ws.create_session("agent")
        said = await Session(ws, "agent").explain.vfs.mkdir("/ro/d")
    assert (said.outcome, said.error) == (Outcome.DENY, "EROFS")


class _Flag(Policy):
    """Refuses writes while ``/data/flag`` reads ``closed``."""

    def __init__(self, ws: Workspace) -> None:
        self.ws = ws

    async def pre_vfs(self, ctx: VfsContext) -> Deny | None:
        if ctx.call.name != "write" or ctx.path.virtual == "/data/flag":
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
    reads a hidden file as the agent and stamps one."""

    def __init__(self, ws: Workspace) -> None:
        self.ws = ws
        self.errors: list[int | None] = []

    async def _busy(self) -> None:
        try:
            await Session(self.ws, "agent").vfs.read("/data/vault/v")
        except OSError as exc:
            self.errors.append(exc.errno)
        try:
            await self.ws.vfs.write("/data/stamp", b"seen")
        except PermissionError as exc:
            self.errors.append(exc.errno)

    async def pre_vfs(self, ctx: VfsContext) -> None:
        if ctx.call.name == "write" and ctx.path.virtual == "/data/new":
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
    assert busy.errors == [errno.ENOENT, errno.EROFS]
    assert ws.decisions.pending("agent") == ()
    assert not await ws.vfs.exists("/data/stamp")


@pytest.mark.asyncio
async def test_a_line_s_policies_change_nothing_either(ws):
    busy = _Busy(ws)
    ws.policies.add(busy)
    await Session(ws, "agent").explain.shell("ls /data/new")
    assert busy.errors == [errno.ENOENT, errno.EROFS]
    assert ws.decisions.pending("agent") == ()
    assert not await ws.vfs.exists("/data/stamp")
