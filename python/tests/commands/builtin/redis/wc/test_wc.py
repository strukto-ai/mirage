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
    resource = RedisResource(url=REDIS_URL, key_prefix="test:wc:")
    await resource._store.clear()
    ws = Workspace({"/": resource}, mode=MountMode.WRITE)
    yield ws
    await resource._store.clear()
    await resource._store.close()


@pytest.mark.asyncio
async def test_wc_default(workspace):
    await workspace.ops.write("/f.txt", b"hello world\nfoo bar\n")
    io = await workspace.execute("wc /f.txt")
    assert io.exit_code == 0
    parts = io.stdout.decode().split()
    assert parts[0] == "2"
    assert parts[1] == "4"
    assert parts[2] == "20"


@pytest.mark.asyncio
async def test_wc_l(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\n")
    io = await workspace.execute("wc -l /f.txt")
    assert io.exit_code == 0
    assert io.stdout.decode().split()[0] == "3"


@pytest.mark.asyncio
async def test_wc_c(workspace):
    await workspace.ops.write("/f.txt", b"hello\n")
    io = await workspace.execute("wc -c /f.txt")
    assert io.exit_code == 0
    assert io.stdout.decode().split()[0] == "6"


@pytest.mark.asyncio
async def test_wc_multi_file_emits_total(workspace):
    await workspace.ops.write("/a.txt", b"hello\n")
    await workspace.ops.write("/b.txt", b"world\nfoo\n")
    io = await workspace.execute("wc /a.txt /b.txt")
    assert io.exit_code == 0
    assert io.stdout.endswith(b"\n")
    lines = io.stdout.decode().splitlines()
    assert lines[-1].endswith("total")
