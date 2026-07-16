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

import pytest

from mirage.workspace.store.ram import RAMWorkspaceStateStore


def test_group_overrides_route_only_their_plane():
    observer_home = RAMWorkspaceStateStore()
    base = RAMWorkspaceStateStore(observer=observer_home)
    assert base.observer("ws") is observer_home.observer("ws")
    assert base.namespace("ws") is not observer_home.namespace("ws")
    assert base.sessions("ws") is not observer_home.sessions("ws")


def test_workspace_override_carries_sessions_and_meta_together():
    control = RAMWorkspaceStateStore()
    base = RAMWorkspaceStateStore(workspace=control)
    assert base.sessions("ws") is control.sessions("ws")


@pytest.mark.asyncio
async def test_workspace_override_meta_lands_on_override():
    control = RAMWorkspaceStateStore()
    base = RAMWorkspaceStateStore(workspace=control)
    await base.set_meta("ws", {"workspace_id": "ws", "created_at": 1.0})
    assert await control.load_meta("ws") == {
        "workspace_id": "ws",
        "created_at": 1.0
    }
    assert await base._load_meta("ws") is None


@pytest.mark.asyncio
async def test_close_closes_overrides_too():
    closed: list[str] = []

    class _Probe(RAMWorkspaceStateStore):

        async def _close(self) -> None:
            closed.append("probe")

    base = RAMWorkspaceStateStore(observer=_Probe())
    await base.close()
    assert closed == ["probe"]
