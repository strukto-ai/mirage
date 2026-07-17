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
from mirage.resource.redis import RedisResource

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def workspace():
    resource = RedisResource(url=REDIS_URL, key_prefix="test:find:")
    await resource._store.clear()
    await resource._store.add_dir("/")
    ws = Workspace({"/": resource}, mode=MountMode.WRITE)
    yield ws
    await resource._store.clear()
    await resource._store.close()


@pytest.mark.asyncio
async def test_find_name_glob(workspace):
    await workspace.ops.write("/hello.txt", b"hi")
    await workspace.ops.write("/world.py", b"hi")
    io = await workspace.execute("find / -name '*.txt'")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "hello.txt" in out
    assert "world.py" not in out


@pytest.mark.asyncio
async def test_find_type_f(workspace):
    await workspace.ops.mkdir("/sub")
    await workspace.ops.write("/a.txt", b"a")
    await workspace.ops.write("/sub/b.txt", b"b")
    io = await workspace.execute("find / -type f")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "/a.txt" in out
    assert "/sub/b.txt" in out


@pytest.mark.asyncio
async def test_find_size_lower_bound(workspace):
    await workspace.ops.write("/big.txt", b"x" * 1000)
    await workspace.ops.write("/small.txt", b"x")
    io = await workspace.execute("find / -size +500c -type f")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "big.txt" in out
    assert "small.txt" not in out


@pytest.mark.asyncio
async def test_find_missing_path_returns_exit_1(workspace):
    io = await workspace.execute("find /nonexistent")
    assert io.exit_code == 1
    assert b"nonexistent" in (io.stderr or b"")
