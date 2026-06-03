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

from mirage import MountMode, Workspace
from mirage.commands.builtin.utils.safeguard import SafeguardExceededError
from mirage.resource.ram import RAMResource
from mirage.types import CommandSafeguard, OnExceed


async def _read_long(accessor, scope, *args, **kwargs):
    return b"hello world"


async def _read_lines(accessor, scope, *args, **kwargs):
    return b"a\nb\nc\nd\n"


async def _read_short(accessor, scope, *args, **kwargs):
    return b"hi"


async def _ws_mount():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo hi > /data/f.txt")
    mount = next(m for m in ws._registry._mounts if m.prefix == "/data/")
    return mount


@pytest.mark.asyncio
async def test_vfs_read_truncates_to_max_bytes(monkeypatch):
    mount = await _ws_mount()
    mount.command_safeguards["read"] = CommandSafeguard(max_bytes=5)
    monkeypatch.setattr(mount._ops[("read", None)], "fn", _read_long)
    assert await mount.execute_op("read", "/data/f.txt") == b"hello"


@pytest.mark.asyncio
async def test_vfs_read_truncates_to_max_lines(monkeypatch):
    mount = await _ws_mount()
    mount.command_safeguards["read"] = CommandSafeguard(max_lines=2)
    monkeypatch.setattr(mount._ops[("read", None)], "fn", _read_lines)
    assert await mount.execute_op("read", "/data/f.txt") == b"a\nb\n"


@pytest.mark.asyncio
async def test_vfs_read_on_exceed_error_raises(monkeypatch):
    mount = await _ws_mount()
    mount.command_safeguards["read"] = CommandSafeguard(
        max_bytes=5, on_exceed=OnExceed.ERROR)
    monkeypatch.setattr(mount._ops[("read", None)], "fn", _read_long)
    with pytest.raises(SafeguardExceededError):
        await mount.execute_op("read", "/data/f.txt")


@pytest.mark.asyncio
async def test_vfs_read_within_limit_untouched(monkeypatch):
    mount = await _ws_mount()
    mount.command_safeguards["read"] = CommandSafeguard(max_bytes=100)
    monkeypatch.setattr(mount._ops[("read", None)], "fn", _read_short)
    assert await mount.execute_op("read", "/data/f.txt") == b"hi"


@pytest.mark.asyncio
async def test_vfs_unconfigured_read_untouched(monkeypatch):
    mount = await _ws_mount()
    monkeypatch.setattr(mount._ops[("read", None)], "fn", _read_long)
    assert await mount.execute_op("read", "/data/f.txt") == b"hello world"


@pytest.mark.asyncio
async def test_vfs_stat_not_capped_by_byte_limit(monkeypatch):
    mount = await _ws_mount()
    mount.command_safeguards["stat"] = CommandSafeguard(max_bytes=1)
    result = await mount.execute_op("stat", "/data/f.txt")
    assert result is not None
    assert not isinstance(result, (bytes, bytearray))
