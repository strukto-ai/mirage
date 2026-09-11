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

from mirage import MountMode, RAMResource, Workspace


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_mv_onto_same_path_errors_and_preserves_file(workspace):
    await workspace.fs.write("/a.txt", b"keep")
    io = await workspace.execute("mv /a.txt /a.txt")
    assert io.exit_code != 0
    assert b"are the same file" in io.stderr
    assert await workspace.fs.read("/a.txt") == b"keep"


@pytest.mark.asyncio
async def test_mv_into_own_subtree_refused(workspace):
    await workspace.fs.mkdir("/d")
    await workspace.fs.write("/d/a.txt", b"a")
    await workspace.fs.mkdir("/d/sub")
    io = await workspace.execute("mv /d /d/sub")
    assert io.exit_code != 0
    assert b"subdirectory of itself" in io.stderr
    assert await workspace.fs.read("/d/a.txt") == b"a"


@pytest.mark.asyncio
async def test_mv_missing_source_reports_cannot_stat(workspace):
    io = await workspace.execute("mv /missing.txt /dst.txt")
    assert io.exit_code != 0
    assert b"mv: cannot stat" in io.stderr


@pytest.mark.asyncio
async def test_mv_into_missing_parent_reports_cannot_move(workspace):
    await workspace.fs.write("/a.txt", b"hi")
    io = await workspace.execute("mv /a.txt /missing/a.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot move '/a.txt' to '/missing/a.txt': "
                         b"No such file or directory\n")
    assert await workspace.fs.read("/a.txt") == b"hi"


@pytest.mark.asyncio
async def test_mv_into_missing_parent_leaves_no_orphan(workspace):
    await workspace.fs.write("/a.txt", b"hi")
    await workspace.execute("mv /a.txt /missing/a.txt")
    listing = await workspace.execute("ls /")
    assert listing.exit_code == 0
    assert b"missing" not in listing.stdout
    assert b"a.txt" in listing.stdout


@pytest.mark.asyncio
async def test_mv_dir_into_missing_parent_reports_cannot_move(workspace):
    await workspace.fs.mkdir("/dir")
    await workspace.fs.write("/dir/f", b"x")
    io = await workspace.execute("mv /dir /gone/dir")
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot move '/dir' to '/gone/dir': "
                         b"No such file or directory\n")
    assert await workspace.fs.read("/dir/f") == b"x"


@pytest.mark.asyncio
async def test_mv_under_a_file_reports_not_a_directory(workspace):
    await workspace.fs.write("/a.txt", b"hi")
    await workspace.fs.write("/plain", b"y")
    io = await workspace.execute("mv /a.txt /plain/c.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot move '/a.txt' to '/plain/c.txt': "
                         b"Not a directory\n")
    assert await workspace.fs.read("/a.txt") == b"hi"


@pytest.mark.asyncio
async def test_mv_source_under_a_plain_file_is_not_a_directory(workspace):
    # Same as cp: the source keeps the errno GNU reports, and the backends
    # cannot supply it from stat alone.
    await workspace.fs.write("/plain", b"x")
    io = await workspace.execute("mv /plain/child /dst")
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot stat '/plain/child': Not a directory\n")


@pytest.mark.asyncio
async def test_mv_absent_source_is_still_no_such_file(workspace):
    io = await workspace.execute("mv /nope /dst")
    assert io.exit_code == 1
    assert io.stderr == (b"mv: cannot stat '/nope': "
                         b"No such file or directory\n")
