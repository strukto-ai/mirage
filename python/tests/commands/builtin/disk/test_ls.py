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

from mirage import DiskVFS, MountMode, Workspace


@pytest.fixture
def workspace(tmp_path):
    return Workspace({"/": DiskVFS(root=str(tmp_path))}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_ls_lists_files(workspace):
    await workspace.vfs.write("/a.txt", b"a")
    await workspace.vfs.write("/b.txt", b"b")
    io = await workspace.shell("ls /")
    assert io.exit_code == 0
    names = set(io.stdout.decode().strip().split("\n"))
    assert "a.txt" in names
    assert "b.txt" in names


@pytest.mark.asyncio
async def test_ls_a_shows_dotfiles(workspace):
    await workspace.vfs.write("/.hidden", b"h")
    await workspace.vfs.write("/visible.txt", b"v")
    io = await workspace.shell("ls -a /")
    assert io.exit_code == 0
    names = set(io.stdout.decode().strip().split("\n"))
    assert ".hidden" in names
    assert "visible.txt" in names


@pytest.mark.asyncio
async def test_ls_l_long_format_includes_size(workspace):
    await workspace.vfs.write("/f.txt", b"hello")
    io = await workspace.shell("ls -l /")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "f.txt" in out
    assert "5" in out


@pytest.mark.asyncio
async def test_ls_F_classify_marks_dirs(workspace):
    await workspace.vfs.mkdir("/sub")
    await workspace.vfs.write("/sub/a.txt", b"a")
    io = await workspace.shell("ls -F /")
    assert io.exit_code == 0
    assert "sub/" in io.stdout.decode()


@pytest.mark.asyncio
async def test_ls_R_recursive(workspace):
    await workspace.vfs.mkdir("/sub")
    await workspace.vfs.write("/sub/a.txt", b"a")
    io = await workspace.shell("ls -R /")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "a.txt" in out


@pytest.mark.asyncio
async def test_ls_d_lists_dir_itself(workspace):
    await workspace.vfs.mkdir("/sub")
    io = await workspace.shell("ls -d /sub")
    assert io.exit_code == 0
    assert "sub" in io.stdout.decode()


@pytest.mark.asyncio
async def test_ls_missing_path_returns_exit_2(workspace):
    # GNU ls exits 2 when a command-line operand cannot be accessed.
    io = await workspace.shell("ls /nope")
    assert io.exit_code == 2
    assert b"nope" in (io.stderr or b"")
