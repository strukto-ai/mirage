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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_tee_writes_inside_the_granted_region():
    # The session reads the mount, but a shown region grants it writes:
    # each write is held to its own region's mode at the dispatcher.
    vfs = RAMVFS()
    vfs._store.dirs.update({"/", "/build"})
    ws = Workspace(
        {"/s3/": (vfs, MountMode.WRITE)},
        profiles={
            "agent": {
                "mounts": {"/s3": "r"},
                "paths": {"show": {"/s3/build": "rw"}},
            }
        },
    )
    ws.create_session("agent", profile="agent")
    try:
        granted = await ws.shell(
            "echo x | tee /s3/build/out.txt", session_id="agent"
        )
        assert granted.exit_code == 0, await granted.stderr_str()
        refused = await ws.shell(
            "echo x | tee /s3/out.txt", session_id="agent"
        )
        assert refused.exit_code == 1
        assert await refused.stderr_str() == (
            "tee: /s3/out.txt: Read-only file system\n"
        )
    finally:
        await ws.close()
    assert vfs._store.files == {"/build/out.txt": b"x\n"}
