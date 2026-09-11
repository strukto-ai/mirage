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
    resource = RedisResource(url=REDIS_URL, key_prefix="test:du:")
    await resource._store.clear()
    ws = Workspace({"/": resource}, mode=MountMode.WRITE)
    yield ws
    await resource._store.clear()
    await resource._store.close()


@pytest.mark.asyncio
async def test_du_single_file(workspace):
    await workspace.fs.write("/f.txt", b"hello")
    io = await workspace.execute("du /f.txt")
    assert io.exit_code == 0
    assert io.stdout.decode().strip() == "5\t/f.txt"


@pytest.mark.asyncio
async def test_du_directory_collapses(workspace):
    await workspace.fs.mkdir("/dir")
    await workspace.fs.write("/dir/a.txt", b"aaa")
    await workspace.fs.write("/dir/b.txt", b"bb")
    io = await workspace.execute("du /dir")
    assert io.exit_code == 0
    assert io.stdout.decode().strip() == "5\t/dir"


@pytest.mark.asyncio
async def test_du_a_lists_files(workspace):
    await workspace.fs.mkdir("/dir")
    await workspace.fs.write("/dir/a.txt", b"aaa")
    await workspace.fs.write("/dir/b.txt", b"bb")
    io = await workspace.execute("du -a /dir")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "a.txt" in out
    assert "b.txt" in out


@pytest.mark.asyncio
async def test_du_c_total(workspace):
    await workspace.fs.write("/a.txt", b"hello")
    await workspace.fs.write("/b.txt", b"world")
    io = await workspace.execute("du -c /a.txt /b.txt")
    assert io.exit_code == 0
    lines = io.stdout.decode().strip().splitlines()
    assert lines[-1] == "10\ttotal"


@pytest.mark.asyncio
async def test_du_without_operand_measures_the_working_directory(workspace):
    """GNU du with no operand summarises '.', dot-spelled; no error."""
    await workspace.fs.write("/a.txt", b"hello")
    io = await workspace.execute("du")
    assert io.exit_code == 0
    assert "5\t." in io.stdout.decode().splitlines()


@pytest.mark.asyncio
async def test_du_reads_an_unstattable_mount_root():
    """Redis never materialises the root entry, but the tree is real.

    A failed stat is not proof of absence, so du must still report the
    subtree instead of calling the operand unreadable. Mounted away from
    ``/`` so the operand does not fan out across sibling mounts.
    """
    resource = RedisResource(url=REDIS_URL, key_prefix="test:du:root:")
    await resource._store.clear()
    ws = Workspace({"/data": resource}, mode=MountMode.WRITE)
    try:
        await ws.fs.write("/data/a.txt", b"hello")
        io = await ws.execute("du /data")
        assert io.exit_code == 0
        assert io.stdout.decode() == "5\t/data\n"
        assert (io.stderr or b"") == b""
    finally:
        await resource._store.clear()
        await resource._store.close()


@pytest.mark.asyncio
async def test_du_reports_an_unreadable_operand(workspace):
    io = await workspace.execute("du /nope")
    assert io.exit_code == 1
    assert b"du: cannot access '/nope'" in (io.stderr or b"")
