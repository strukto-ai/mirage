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
async def test_a_call_without_a_tape_refuses_a_third_operand():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("printf 'a\\n' > /data/a; printf 'b\\n' > /data/b")
    paths = [PathSpec.from_str_path(f"/data/{name}") for name in "abc"]
    _, io = await run_on_mount(ws, "uniq", paths)
    assert io.exit_code == 1
    assert io.stderr.startswith(b"uniq: extra operand '/data/c'\n")
    cat = await ws.shell("cat /data/b")
    assert await cat.materialize_stdout() == b"b\n"
    await ws.close()
