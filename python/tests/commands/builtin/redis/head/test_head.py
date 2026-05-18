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
    resource = RedisResource(url=REDIS_URL, key_prefix="test:head:")
    await resource._store.clear()
    ws = Workspace({"/": resource}, mode=MountMode.WRITE)
    yield ws
    await resource._store.clear()
    await resource._store.close()


@pytest.mark.asyncio
async def test_head_default_n_10(workspace):
    body = b"".join(f"line{i}\n".encode() for i in range(1, 15))
    await workspace.ops.write("/f.txt", body)
    io = await workspace.execute("head /f.txt", session_id="default")
    assert io.exit_code == 0
    lines = io.stdout.decode().splitlines()
    assert len(lines) == 10
    assert lines[0] == "line1"
    assert lines[9] == "line10"


@pytest.mark.asyncio
async def test_head_n_explicit(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\nd\n")
    io = await workspace.execute("head -n 2 /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"a\nb\n"


@pytest.mark.asyncio
async def test_head_c_bytes(workspace):
    await workspace.ops.write("/f.txt", b"hello world")
    io = await workspace.execute("head -c 5 /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"hello"


@pytest.mark.asyncio
async def test_head_negative_n_excludes_last(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\nd\n")
    io = await workspace.execute("head -n -1 /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_head_multi_file_emits_headers(workspace):
    await workspace.ops.write("/a.txt", b"x\ny\n")
    await workspace.ops.write("/b.txt", b"z\n")
    io = await workspace.execute("head /a.txt /b.txt", session_id="default")
    assert io.exit_code == 0
    assert b"==> /a.txt <==" in io.stdout
    assert b"==> /b.txt <==" in io.stdout
