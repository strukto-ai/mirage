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
async def test_an_operand_that_does_not_read_is_named_as_gnu_names_it():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell("mkdir /data/d; tsort /data/nope; tsort /data/d")
    assert await io.materialize_stdout() == b""
    assert await io.materialize_stderr() == (
        b"tsort: /data/nope: No such file or directory\n"
        b"tsort: /data/d: read error: Is a directory\n"
    )
    assert io.exit_code == 1
    await ws.close()
