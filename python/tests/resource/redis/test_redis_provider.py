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

from mirage.resource.redis import RedisResource
from mirage.types import MountMode
from mirage.workspace import Workspace

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def ws():
    resource = RedisResource(url=REDIS_URL, key_prefix="test:integ:")
    await resource._store.clear()
    await resource._store.add_dir("/")
    w = Workspace(
        {"/data": (resource, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    yield w
    await resource._store.clear()
    await resource._store.close()


async def _run(ws, cmd, stdin=None):
    io = await ws.execute(cmd, stdin=stdin)
    stdout = io.stdout
    if stdout is None:
        return ""
    if isinstance(stdout, bytes):
        return stdout.decode(errors="replace")
    chunks = [chunk async for chunk in stdout]
    return b"".join(chunks).decode(errors="replace")


@pytest.mark.asyncio
async def test_echo_and_cat(ws):
    await _run(ws, "echo hello > /data/hello.txt")
    result = await _run(ws, "cat /data/hello.txt")
    assert result == "hello\n"


@pytest.mark.asyncio
async def test_ls(ws):
    await _run(ws, "echo a > /data/a.txt")
    await _run(ws, "echo b > /data/b.txt")
    result = await _run(ws, "ls /data/")
    assert "a.txt" in result
    assert "b.txt" in result


@pytest.mark.asyncio
async def test_stat(ws):
    await _run(ws, "echo hello > /data/f.txt")
    result = await _run(ws, "stat /data/f.txt")
    assert "name=f.txt" in result
    assert "size=" in result


@pytest.mark.asyncio
async def test_head(ws):
    await _run(ws, "echo 'line1\nline2\nline3' > /data/f.txt")
    result = await _run(ws, "head -n 2 /data/f.txt")
    assert "line1" in result
    assert "line2" in result


@pytest.mark.asyncio
async def test_grep(ws):
    await _run(
        ws,
        "echo 'hello world\nfoo bar\nhello again' "
        "> /data/f.txt",
    )
    result = await _run(ws, "grep hello /data/f.txt")
    assert "hello world" in result
    assert "hello again" in result
    assert "foo bar" not in result


@pytest.mark.asyncio
async def test_wc(ws):
    await _run(ws, "echo 'hello world' > /data/f.txt")
    result = await _run(ws, "wc /data/f.txt")
    assert "1" in result


@pytest.mark.asyncio
async def test_mkdir(ws):
    await _run(ws, "mkdir /data/sub")
    result = await _run(ws, "ls /data/")
    assert "sub" in result


@pytest.mark.asyncio
async def test_mkdir_p(ws):
    await _run(ws, "mkdir -p /data/a/b/c")
    result = await _run(ws, "stat /data/a/b/c")
    assert "directory" in result


@pytest.mark.asyncio
async def test_cp(ws):
    await _run(ws, "echo data > /data/src.txt")
    await _run(ws, "cp /data/src.txt /data/dst.txt")
    result = await _run(ws, "cat /data/dst.txt")
    assert "data" in result


@pytest.mark.asyncio
async def test_mv(ws):
    await _run(ws, "echo data > /data/old.txt")
    await _run(ws, "mv /data/old.txt /data/new.txt")
    result = await _run(ws, "cat /data/new.txt")
    assert "data" in result
    ls_result = await _run(ws, "ls /data/")
    assert "old.txt" not in ls_result


@pytest.mark.asyncio
async def test_rm(ws):
    await _run(ws, "echo data > /data/f.txt")
    await _run(ws, "rm /data/f.txt")
    result = await _run(ws, "ls /data/")
    assert "f.txt" not in result


@pytest.mark.asyncio
async def test_tree(ws):
    await _run(ws, "echo a > /data/a.txt")
    await _run(ws, "mkdir /data/sub")
    await _run(ws, "echo b > /data/sub/b.txt")
    result = await _run(ws, "tree /data/")
    assert "a.txt" in result
    assert "sub" in result
    assert "b.txt" in result


@pytest.mark.asyncio
async def test_find(ws):
    await _run(ws, "echo a > /data/a.txt")
    await _run(ws, "mkdir /data/sub")
    await _run(ws, "echo b > /data/sub/b.py")
    result = await _run(ws, "find /data/ -name '*.py'")
    assert "b.py" in result
    assert "a.txt" not in result


@pytest.mark.asyncio
async def test_du(ws):
    await _run(ws, "echo hello > /data/f.txt")
    result = await _run(ws, "du /data/")
    assert result.strip() != ""


@pytest.mark.asyncio
async def test_pipe(ws):
    await _run(ws, "echo 'a\nb\na\nc\na' > /data/f.txt")
    result = await _run(ws, "grep a /data/f.txt | wc -l")
    assert result.strip() == "3"


@pytest.mark.asyncio
async def test_cd_and_pwd(ws):
    await _run(ws, "echo hi > /data/f.txt")
    await _run(ws, "cd /data/")
    result = await _run(ws, "pwd")
    assert "/data" in result


@pytest.mark.asyncio
async def test_data_persists_across_commands(ws):
    await _run(ws, "echo persistent > /data/p.txt")
    result1 = await _run(ws, "cat /data/p.txt")
    result2 = await _run(ws, "cat /data/p.txt")
    assert result1 == result2 == "persistent\n"


@pytest.mark.asyncio
async def test_get_state_reads_only_a_metacharacter_prefix():
    mine = RedisResource(url=REDIS_URL, key_prefix="test:[ab]?:")
    neighbour = RedisResource(url=REDIS_URL, key_prefix="test:ax:")
    try:
        await mine._store.clear()
        await neighbour._store.clear()
        await neighbour._store.set_file("/other", b"x")
        await mine._store.set_file("/mine", b"y")
        assert sorted(mine.get_state()["files"]) == ["/mine"]
    finally:
        await mine._store.clear()
        await neighbour._store.clear()
        await mine._store.close()
        await neighbour._store.close()
