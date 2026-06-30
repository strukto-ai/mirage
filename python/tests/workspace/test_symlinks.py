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


def _ws():
    return Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_ln_readlink_verbatim():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    r = await ws.execute("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_ln_relative_target_kept_verbatim():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s a.txt /data/link.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "a.txt\n"


@pytest.mark.asyncio
async def test_ln_sf_overwrites():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt")
    await ws.execute("echo b > /data/b.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    await ws.execute("ln -s -f /data/b.txt /data/link.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/b.txt\n"


@pytest.mark.asyncio
async def test_ln_no_force_refuses_existing_link():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 1
    assert b"File exists" in r.stderr


@pytest.mark.asyncio
async def test_cd_through_symlink():
    ws = _ws()
    await ws.execute("mkdir -p /data/real")
    await ws.execute("ln -s /data/real /data/slink")
    r = await ws.execute("cd /data/slink && pwd")
    assert r.stdout.decode() == "/data/real\n"


@pytest.mark.asyncio
async def test_cd_symlink_loop_is_eloop():
    ws = _ws()
    await ws.execute("ln -s /data/b /data/a")
    await ws.execute("ln -s /data/a /data/b")
    r = await ws.execute("cd /data/a")
    assert r.exit_code == 1
    assert b"Too many levels of symbolic links" in r.stderr


@pytest.mark.asyncio
async def test_symlink_survives_snapshot(tmp_path):
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    target = str(tmp_path / "snap.tar")
    await ws.snapshot(target)
    ws2 = await Workspace.load(target)
    r = await ws2.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"
