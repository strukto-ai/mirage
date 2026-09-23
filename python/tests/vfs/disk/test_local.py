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

from mirage import MountMode, Workspace
from mirage.vfs.disk.disk import DiskVFS


@pytest.fixture
def local_backend(tmp_path):
    return DiskVFS(str(tmp_path))


@pytest.fixture
def ws(tmp_path):
    vfs = DiskVFS(str(tmp_path))
    return Workspace({"/data": vfs}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_create_and_cat(ws):
    await ws.shell('echo "hello" | tee /data/hello.txt')
    result = await ws.shell("cat /data/hello.txt")
    assert b"hello" in result.stdout


@pytest.mark.asyncio
async def test_mkdir_and_ls(ws):
    await ws.shell("mkdir /data/mydir")
    result = await ws.shell("ls /data/")
    assert b"mydir" in result.stdout


@pytest.mark.asyncio
async def test_rm(ws):
    await ws.shell('echo "x" | tee /data/del.txt')
    await ws.shell("rm /data/del.txt")
    result = await ws.shell("stat /data/del.txt")
    assert result.exit_code != 0


@pytest.mark.asyncio
async def test_stat_file(ws):
    await ws.shell('echo "hello" | tee /data/f.txt')
    result = await ws.shell("stat /data/f.txt")
    assert result.exit_code == 0
    assert b"name=f.txt" in result.stdout


@pytest.mark.asyncio
async def test_stat_directory(ws):
    await ws.shell("mkdir /data/mydir")
    result = await ws.shell("stat /data/mydir")
    assert result.exit_code == 0
    assert b"directory" in result.stdout


@pytest.mark.asyncio
async def test_stat_missing_raises(ws):
    result = await ws.shell("stat /data/missing.txt")
    assert result.exit_code != 0


@pytest.mark.asyncio
async def test_path_traversal_raises(local_backend):
    from mirage.core.disk.stat import stat as core_stat
    from mirage.types import PathSpec  # noqa: F811
    with pytest.raises(ValueError):
        await core_stat(
            local_backend.accessor,
            PathSpec(vfs_path="../etc/passwd",
                     virtual="/../etc/passwd",
                     directory="/../etc/passwd"))


@pytest.mark.asyncio
async def test_get_state_preserves_file_mode(tmp_path):
    src = DiskVFS(str(tmp_path / "src"))
    ws = Workspace({"/data": src}, mode=MountMode.WRITE)
    await ws.shell("echo hi > /data/f.txt && chmod 640 /data/f.txt")
    state = src.get_state()
    assert state["modes"]["f.txt"] == 0o640

    dst = DiskVFS(str(tmp_path / "dst"))
    dst.load_state(state)
    assert (tmp_path / "dst" / "f.txt").stat().st_mode & 0o777 == 0o640
