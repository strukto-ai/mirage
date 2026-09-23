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

from mirage import RAMVFS, MountMode, Workspace


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_touch_into_missing_parent_reports_cannot_touch(workspace):
    io = await workspace.shell("touch /missing/f.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"touch: cannot touch '/missing/f.txt': "
                         b"No such file or directory\n")


@pytest.mark.asyncio
async def test_touch_into_missing_parent_leaves_no_orphan(workspace):
    await workspace.shell("touch /missing/f.txt")
    listing = await workspace.shell("ls /")
    assert listing.exit_code == 0
    assert b"missing" not in listing.stdout


@pytest.mark.asyncio
async def test_touch_under_a_plain_file_reports_not_a_directory(workspace):
    await workspace.vfs.write("/plain", b"x")
    io = await workspace.shell("touch /plain/f.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"touch: cannot touch '/plain/f.txt': "
                         b"Not a directory\n")


@pytest.mark.asyncio
async def test_touch_deep_under_a_plain_file_reports_not_a_directory(
        workspace):
    await workspace.vfs.write("/plain", b"x")
    io = await workspace.shell("touch /plain/sub/f.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"touch: cannot touch '/plain/sub/f.txt': "
                         b"Not a directory\n")


@pytest.mark.asyncio
async def test_touch_keeps_going_after_a_failed_operand(workspace):
    # GNU reports the bad operand and still creates the rest, exiting 1.
    io = await workspace.shell("touch /ok1.txt /missing/f.txt /ok2.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"touch: cannot touch '/missing/f.txt': "
                         b"No such file or directory\n")
    listing = await workspace.shell("ls /")
    assert b"ok1.txt" in listing.stdout
    assert b"ok2.txt" in listing.stdout


@pytest.mark.asyncio
async def test_touch_reports_every_failed_operand(workspace):
    io = await workspace.shell("touch /missing/a /missing/b")
    assert io.exit_code == 1
    assert io.stderr == (b"touch: cannot touch '/missing/a': "
                         b"No such file or directory\n"
                         b"touch: cannot touch '/missing/b': "
                         b"No such file or directory\n")


@pytest.mark.asyncio
async def test_touch_into_an_existing_dir_succeeds(workspace):
    await workspace.vfs.mkdir("/d")
    io = await workspace.shell("touch /d/f.txt")
    assert io.exit_code == 0
    assert io.stderr in (b"", None)
    assert await workspace.vfs.read("/d/f.txt") == b""
