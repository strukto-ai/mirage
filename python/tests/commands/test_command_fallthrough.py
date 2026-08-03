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

from mirage.commands.registry import command
from mirage.commands.spec import CommandSpec, Operand, ValueType
from mirage.io.types import IOResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

SPEC = CommandSpec(rest=Operand(type="path"), )


@command("testcmd", resource="ram", filetype=".custom", spec=SPEC)
async def _testcmd_custom(store, paths, *texts, **kw):
    return None


@command("testcmd", resource="ram", spec=SPEC)
async def _testcmd_default(store, paths, *texts, **kw):
    return b"default handler", IOResult()


@command("testcmd2", resource="ram", filetype=".special", spec=SPEC)
async def _testcmd2_special(store, paths, *texts, **kw):
    return b"special handler", IOResult()  # noqa


@command("testcmd2", resource="ram", spec=SPEC)
async def _testcmd2_default(store, paths, *texts, **kw):
    return b"default handler", IOResult()


@pytest.mark.asyncio
async def test_command_fallthrough_on_none():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    mount = ws._registry.mount_for("/data/")
    for rc in _testcmd_custom._registered_commands:
        mount.register(rc)
    for rc in _testcmd_default._registered_commands:
        mount.register(rc)
    await ws.execute("mkdir -p /data")
    await ws.execute("touch /data/file.custom")
    io = await ws.execute("testcmd /data/file.custom")
    assert io.stdout == b"default handler"


@pytest.mark.asyncio
async def test_command_no_fallthrough_when_stdout_present():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    mount = ws._registry.mount_for("/data/")
    for rc in _testcmd2_special._registered_commands:
        mount.register(rc)
    for rc in _testcmd2_default._registered_commands:
        mount.register(rc)
    await ws.execute("mkdir -p /data")
    await ws.execute("touch /data/file.special")
    io = await ws.execute("testcmd2 /data/file.special")
    assert io.stdout == b"special handler"
