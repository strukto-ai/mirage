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

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.server.registry import WorkspaceRegistry
from mirage.workspace.record.disk import DiskRecordClient


@pytest.mark.asyncio
async def test_an_overlapping_remove_joins_the_deletion_in_flight(
    monkeypatch,
):
    # A second deletion of its own would stop the runner again, then
    # release the id after a create had reused it.
    registry = WorkspaceRegistry(idle_grace_seconds=10.0)
    entry = registry.add(Workspace({"/": (RAMVFS(), MountMode.WRITE)}), "w")
    stops: list[bool] = []
    stop = entry.runner.stop

    async def counted_stop(*, delete: bool = False) -> None:
        stops.append(delete)
        await stop(delete=delete)

    monkeypatch.setattr(entry.runner, "stop", counted_stop)
    first, second = await asyncio.gather(
        registry.remove("w"), registry.remove("w")
    )
    assert first is second is entry
    assert stops == [True]
    assert "w" not in registry


def _ws() -> Workspace:
    return Workspace({"/": (RAMVFS(), MountMode.WRITE)})


@pytest.mark.asyncio
async def test_an_account_sees_only_the_workspaces_it_owns():
    registry = WorkspaceRegistry(idle_grace_seconds=10.0)
    mine = registry.add(_ws(), "mine", owner="alice")
    registry.add(_ws(), "theirs", owner="bob")
    registry.add(_ws(), "nobodys")
    assert registry.visible("mine", "alice") is mine
    assert registry.visible("theirs", "alice") is None
    assert registry.visible("nobodys", "alice") is None
    assert registry.visible("missing", "alice") is None
    assert registry.visible("theirs", None) is not None
    await registry.close_all()


@pytest.mark.asyncio
async def test_required_accounts_refuse_a_caller_without_one():
    registry = WorkspaceRegistry(
        idle_grace_seconds=10.0, accounts_required=True
    )
    registry.add(_ws(), "w", owner="alice")
    assert registry.visible("w", None) is None
    assert not await registry.allows("w", None)
    assert registry.visible("w", "alice") is not None
    await registry.close_all()


@pytest.mark.asyncio
async def test_a_claim_outlives_the_registry(tmp_path):
    owners = DiskRecordClient(str(tmp_path), "owners")
    first = WorkspaceRegistry(idle_grace_seconds=10.0, owners=owners)
    assert await first.claim("w", "alice")
    first.add(_ws(), "w", owner="alice")
    await first.close_all()
    # A restarted daemon: nothing is live, the claim still is.
    second = WorkspaceRegistry(idle_grace_seconds=10.0, owners=owners)
    assert await second.allows("w", "alice")
    assert not await second.allows("w", "bob")
    assert not await second.claim("w", "bob")
    assert await second.claim("w", "alice")
    assert await second.claim("w", None)


@pytest.mark.asyncio
async def test_a_delete_releases_the_claim(tmp_path):
    owners = DiskRecordClient(str(tmp_path), "owners")
    registry = WorkspaceRegistry(idle_grace_seconds=10.0, owners=owners)
    assert await registry.claim("w", "alice")
    registry.add(_ws(), "w", owner="alice")
    await registry.remove("w")
    assert await registry.claim("w", "bob")
