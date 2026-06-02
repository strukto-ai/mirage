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

from mirage import MountMode, Workspace
from mirage.commands.builtin.utils.safeguard import CommandTimeoutError
from mirage.resource.ram import RAMResource
from mirage.types import CommandSafeguard


async def _slow_op(accessor, scope, *args, **kwargs):
    await asyncio.sleep(5)
    return None


async def _slowish_op(accessor, scope, *args, **kwargs):
    await asyncio.sleep(0.2)
    return "ok"


async def _ws_mount():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo hi > /data/f.txt")
    mount = next(m for m in ws._registry._mounts if m.prefix == "/data/")
    return mount


@pytest.mark.asyncio
async def test_vfs_op_honors_per_mount_timeout(monkeypatch):
    mount = await _ws_mount()
    mount.command_safeguards["stat"] = CommandSafeguard(timeout_seconds=0.05)
    monkeypatch.setattr(mount._ops[("stat", None)], "fn", _slow_op)
    with pytest.raises(CommandTimeoutError):
        await mount.execute_op("stat", "/data/f.txt")


@pytest.mark.asyncio
async def test_vfs_op_unconfigured_is_not_timed(monkeypatch):
    mount = await _ws_mount()
    monkeypatch.setattr(mount._ops[("stat", None)], "fn", _slowish_op)
    result = await mount.execute_op("stat", "/data/f.txt")
    assert result == "ok"
