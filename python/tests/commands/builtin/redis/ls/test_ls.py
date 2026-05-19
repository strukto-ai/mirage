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
    resource = RedisResource(url=REDIS_URL, key_prefix="test:ls:")
    await resource._store.clear()
    await resource._store.add_dir("/")
    ws = Workspace({"/": resource}, mode=MountMode.WRITE)
    yield ws
    await resource._store.clear()
    await resource._store.close()


@pytest.mark.asyncio
async def test_ls_lists_files(workspace):
    await workspace.ops.write("/a.txt", b"a")
    await workspace.ops.write("/b.txt", b"b")
    io = await workspace.execute("ls /", session_id="default")
    assert io.exit_code == 0
    names = set(io.stdout.decode().strip().split("\n"))
    assert "a.txt" in names
    assert "b.txt" in names


@pytest.mark.asyncio
async def test_ls_a_shows_dotfiles(workspace):
    await workspace.ops.write("/.hidden", b"h")
    await workspace.ops.write("/visible.txt", b"v")
    io = await workspace.execute("ls -a /", session_id="default")
    assert io.exit_code == 0
    names = set(io.stdout.decode().strip().split("\n"))
    assert ".hidden" in names
    assert "visible.txt" in names


@pytest.mark.asyncio
async def test_ls_l_long_format_includes_size(workspace):
    await workspace.ops.write("/f.txt", b"hello")
    io = await workspace.execute("ls -l /", session_id="default")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "f.txt" in out
    assert "5" in out


@pytest.mark.asyncio
async def test_ls_d_lists_dir_itself(workspace):
    await workspace.ops.mkdir("/sub")
    io = await workspace.execute("ls -d /sub", session_id="default")
    assert io.exit_code == 0
    assert "sub" in io.stdout.decode()


@pytest.mark.asyncio
async def test_ls_missing_path_returns_exit_1(workspace):
    io = await workspace.execute("ls /nope", session_id="default")
    assert io.exit_code == 1
    assert b"nope" in (io.stderr or b"")
