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
    resource = RedisResource(url=REDIS_URL, key_prefix="test:cat:")
    await resource._store.clear()
    ws = Workspace({"/": resource}, mode=MountMode.WRITE)
    yield ws
    await resource._store.clear()
    await resource._store.close()


@pytest.mark.asyncio
async def test_cat_basic(workspace):
    await workspace.ops.write("/f.txt", b"hello\nworld\n")
    io = await workspace.execute("cat /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"hello\nworld\n"


@pytest.mark.asyncio
async def test_cat_n_single_digit_alignment(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\n")
    io = await workspace.execute("cat -n /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"     1\ta\n     2\tb\n"


@pytest.mark.asyncio
async def test_cat_n_multidigit_alignment(workspace):
    body = b"".join(f"line{i}\n".encode() for i in range(1, 13))
    await workspace.ops.write("/big.txt", body)
    io = await workspace.execute("cat -n /big.txt", session_id="default")
    assert io.exit_code == 0
    lines = io.stdout.split(b"\n")
    assert lines[0] == b"     1\tline1"
    assert lines[8] == b"     9\tline9"
    assert lines[9] == b"    10\tline10"
    assert lines[11] == b"    12\tline12"


@pytest.mark.asyncio
async def test_cat_preserves_no_trailing_newline(workspace):
    await workspace.ops.write("/partial.txt", b"hello")
    io = await workspace.execute("cat /partial.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"hello"


@pytest.mark.asyncio
async def test_cat_n_preserves_no_trailing_newline(workspace):
    await workspace.ops.write("/partial.txt", b"hello")
    io = await workspace.execute("cat -n /partial.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"     1\thello"


@pytest.mark.asyncio
async def test_cat_multi_file_concatenation(workspace):
    await workspace.ops.write("/a.txt", b"aaa\n")
    await workspace.ops.write("/b.txt", b"bbb\n")
    io = await workspace.execute("cat /a.txt /b.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"aaa\nbbb\n"
