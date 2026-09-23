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

import os

import pytest
import pytest_asyncio

from mirage import MountMode, Workspace
from mirage.vfs.redis import RedisVFS

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def workspace():
    vfs = RedisVFS(url=REDIS_URL, key_prefix="test:tree:")
    await vfs._store.clear()
    await vfs._store.add_dir("/")
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    yield ws
    await vfs._store.clear()
    await vfs._store.close()


@pytest.mark.asyncio
async def test_tree_basic(workspace):
    await workspace.vfs.mkdir("/d1")
    await workspace.vfs.write("/d1/a.txt", b"a")
    await workspace.vfs.write("/d1/b.txt", b"b")
    io = await workspace.shell("tree /d1")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "a.txt" in out
    assert "b.txt" in out


@pytest.mark.asyncio
async def test_tree_L_max_depth(workspace):
    await workspace.vfs.mkdir("/d1")
    await workspace.vfs.mkdir("/d1/sub")
    await workspace.vfs.mkdir("/d1/sub/deep")
    await workspace.vfs.write("/d1/sub/deep/file.txt", b"d")
    io = await workspace.shell("tree -L 1 /d1")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "deep" not in out
    assert "file.txt" not in out


@pytest.mark.asyncio
async def test_tree_d_dirs_only(workspace):
    await workspace.vfs.mkdir("/d1")
    await workspace.vfs.mkdir("/d1/sub")
    await workspace.vfs.write("/d1/file.txt", b"x")
    io = await workspace.shell("tree -d /d1")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "file.txt" not in out
