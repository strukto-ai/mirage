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
async def workspace(redis_prefix):
    vfs = RedisVFS(url=REDIS_URL, key_prefix=redis_prefix)
    await vfs._store.clear()
    ws = Workspace({"/": vfs}, mode=MountMode.WRITE)
    yield ws
    await vfs._store.clear()
    await vfs._store.close()


@pytest.mark.asyncio
async def test_cat_n_multidigit_alignment(workspace):
    body = b"".join(f"line{i}\n".encode() for i in range(1, 13))
    await workspace.vfs.write("/big.txt", body)
    io = await workspace.shell("cat -n /big.txt")
    assert io.exit_code == 0
    lines = io.stdout.split(b"\n")
    assert lines[0] == b"     1\tline1"
    assert lines[8] == b"     9\tline9"
    assert lines[9] == b"    10\tline10"
    assert lines[11] == b"    12\tline12"
