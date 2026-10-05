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

from agents.editor import ApplyPatchOperation

from mirage.agents.openai_agents.editor import MirageEditor
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _workspace() -> Workspace:
    return Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/ro": (RAMVFS(), MountMode.READ),
        },
        mode=MountMode.WRITE,
    )


def test_create_file_makes_every_missing_parent():
    async def _run():
        ws = _workspace()
        result = await MirageEditor(ws).create_file(
            ApplyPatchOperation(
                type="create_file", path="/a/b/c/new.py", diff="+print('hi')\n"
            )
        )
        assert result.status == "completed"
        assert await ws.vfs.read("/a/b/c/new.py") == b"print('hi')"

    asyncio.run(_run())


def test_create_file_under_a_read_only_mount_fails():
    async def _run():
        result = await MirageEditor(_workspace()).create_file(
            ApplyPatchOperation(
                type="create_file", path="/ro/sub/new.py", diff="+x\n"
            )
        )
        assert result.status == "failed"
        assert "Read-only file system" in (result.output or "")

    asyncio.run(_run())
