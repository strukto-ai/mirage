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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def test_memory_backend_provides_commands():
    backend = RAMResource()
    cmds = backend.commands()
    names = {c.name for c in cmds}
    assert "cat" in names
    assert "ls" in names
    assert "grep" in names
    assert "wc" in names
    for c in cmds:
        assert c.resource == "ram"


@pytest.mark.asyncio
async def test_registered_commands_used_for_dispatch():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.fs.write("/tmp/a.txt", b"hello world\n")
    result = await ws.execute("cat /tmp/a.txt")
    assert (await result.stdout_str()) == "hello world\n"

    result = await ws.execute("wc -l /tmp/a.txt")
    assert "1" in (await result.stdout_str())
