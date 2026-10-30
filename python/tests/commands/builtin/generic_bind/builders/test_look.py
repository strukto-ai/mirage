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

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.mount_commands import run_on_mount


@pytest.mark.asyncio
async def test_a_file_without_a_prefix_is_bad_usage():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("printf 'apple\\n' > /data/a")
    out, io = await run_on_mount(
        ws, "look", [PathSpec.from_str_path("/data/a")]
    )
    assert out == b""
    assert io.exit_code == 1
    assert io.stderr.startswith(b"look: bad usage\n")
    await ws.close()
