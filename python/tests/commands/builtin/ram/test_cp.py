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
async def test_cp_recursive_into_itself_refused(workspace):
    await workspace.fs.mkdir("/d")
    await workspace.fs.write("/d/a.txt", b"a")
    io = await workspace.execute("cp -r /d /d")
    assert io.exit_code != 0
    assert b"into itself" in io.stderr
    io = await workspace.execute("find /d -type f")
    assert io.stdout.decode().split() == ["/d/a.txt"]


@pytest.mark.asyncio
async def test_cp_onto_same_path_errors(workspace):
    await workspace.fs.write("/a.txt", b"keep")
    io = await workspace.execute("cp /a.txt /a.txt")
    assert io.exit_code != 0
    assert b"are the same file" in io.stderr
    assert await workspace.fs.read("/a.txt") == b"keep"


@pytest.mark.asyncio
async def test_cp_missing_source_continues_with_rest(workspace):
    await workspace.fs.mkdir("/d")
    await workspace.fs.write("/b.txt", b"b")
    io = await workspace.execute("cp /missing.txt /b.txt /d")
    assert io.exit_code != 0
    assert b"cannot stat" in io.stderr
    assert await workspace.fs.read("/d/b.txt") == b"b"


@pytest.mark.asyncio
async def test_cp_into_missing_parent_refuses(workspace):
    await workspace.fs.write("/a.txt", b"hi")
    io = await workspace.execute("cp /a.txt /nodir/x.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot create regular file '/nodir/x.txt': "
                         b"No such file or directory\n")
    listing = await workspace.execute("ls /")
    assert b"nodir" not in listing.stdout


@pytest.mark.asyncio
async def test_cp_under_a_file_reports_not_a_directory(workspace):
    await workspace.fs.write("/a.txt", b"hi")
    await workspace.fs.write("/plain", b"y")
    io = await workspace.execute("cp /a.txt /plain/x.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot stat '/plain/x.txt': Not a directory\n")


@pytest.mark.asyncio
async def test_cp_deep_under_a_file_reports_not_a_directory(workspace):
    await workspace.fs.write("/a.txt", b"hi")
    await workspace.fs.write("/plain", b"y")
    io = await workspace.execute("cp /a.txt /plain/s/x.txt")
    assert io.exit_code == 1
    assert io.stderr == (
        b"cp: cannot stat '/plain/s/x.txt': Not a directory\n")


@pytest.mark.asyncio
async def test_cp_multi_source_missing_target_is_enoent(workspace):
    await workspace.fs.write("/a.txt", b"a")
    await workspace.fs.write("/b.txt", b"b")
    io = await workspace.execute("cp /a.txt /b.txt /nodir")
    assert io.exit_code == 1
    assert io.stderr == (b"cp: target '/nodir': No such file or directory\n")


@pytest.mark.asyncio
async def test_cp_multi_source_target_is_file_is_enotdir(workspace):
    await workspace.fs.write("/a.txt", b"a")
    await workspace.fs.write("/b.txt", b"b")
    await workspace.fs.write("/plain", b"y")
    io = await workspace.execute("cp /a.txt /b.txt /plain")
    assert io.exit_code == 1
    assert io.stderr == (b"cp: target '/plain': Not a directory\n")


@pytest.mark.asyncio
async def test_cp_recursive_verbose_lists_directories(workspace):
    await workspace.fs.mkdir("/dir")
    await workspace.fs.mkdir("/dir/sub")
    await workspace.fs.write("/dir/f.txt", b"f")
    await workspace.fs.write("/dir/sub/g.txt", b"g")
    io = await workspace.execute("cp -rv /dir /newdir")
    assert io.exit_code == 0
    lines = io.stdout.decode().splitlines()
    # GNU prints directories as well as files, parents before children.
    assert "'/dir' -> '/newdir'" in lines
    assert "'/dir/sub' -> '/newdir/sub'" in lines
    assert lines.index("'/dir' -> '/newdir'") < lines.index(
        "'/dir/sub' -> '/newdir/sub'")
    assert lines.index("'/dir/sub' -> '/newdir/sub'") < lines.index(
        "'/dir/sub/g.txt' -> '/newdir/sub/g.txt'")


@pytest.mark.asyncio
async def test_cp_recursive_into_missing_parent_copies_nothing(workspace):
    await workspace.fs.mkdir("/dir")
    await workspace.fs.mkdir("/dir/sub")
    await workspace.fs.write("/dir/f.txt", b"f")
    await workspace.fs.write("/dir/sub/g.txt", b"g")
    io = await workspace.execute("cp -r /dir /nodir/sub")
    assert io.exit_code == 1
    # GNU reports the failed directory once and copies nothing.
    assert io.stderr == (b"cp: cannot create directory '/nodir/sub': "
                         b"No such file or directory\n")
    listing = await workspace.execute("find /nodir")
    assert listing.exit_code != 0


@pytest.mark.asyncio
async def test_cp_source_under_a_plain_file_is_not_a_directory(workspace):
    # Backends answer stat with ENOENT for a path under a plain file, so the
    # source probe has to walk the chain to recover GNU's errno.
    await workspace.fs.write("/plain", b"x")
    await workspace.fs.mkdir("/d")
    io = await workspace.execute("cp /plain/child /d")
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot stat '/plain/child': Not a directory\n")


@pytest.mark.asyncio
async def test_cp_source_deep_under_a_plain_file_is_not_a_directory(workspace):
    await workspace.fs.write("/plain", b"x")
    await workspace.fs.mkdir("/d")
    io = await workspace.execute("cp /plain/a/b /d")
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot stat '/plain/a/b': Not a directory\n")


@pytest.mark.asyncio
async def test_cp_absent_source_is_still_no_such_file(workspace):
    await workspace.fs.mkdir("/d")
    io = await workspace.execute("cp /nope /d")
    assert io.exit_code == 1
    assert io.stderr == (b"cp: cannot stat '/nope': "
                         b"No such file or directory\n")
