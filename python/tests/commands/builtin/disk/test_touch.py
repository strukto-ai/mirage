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

from mirage import DiskResource, MountMode, Workspace


@pytest.fixture
def workspace(tmp_path):
    return Workspace({"/": DiskResource(root=tmp_path)}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_touch_into_missing_parent_reports_cannot_touch(workspace):
    # A real filesystem answers stat with ENOTDIR where the store-backed
    # backends answer ENOENT, so both have to reach the same GNU line.
    io = await workspace.execute("touch /missing/f.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"touch: cannot touch '/missing/f.txt': "
                         b"No such file or directory\n")


@pytest.mark.asyncio
async def test_touch_does_not_create_the_parent(workspace, tmp_path):
    await workspace.execute("touch /missing/f.txt")
    assert not (tmp_path / "missing").exists()


@pytest.mark.asyncio
async def test_touch_under_a_plain_file_reports_not_a_directory(workspace):
    await workspace.fs.write("/plain", b"x")
    io = await workspace.execute("touch /plain/f.txt")
    assert io.exit_code == 1
    assert io.stderr == (b"touch: cannot touch '/plain/f.txt': "
                         b"Not a directory\n")


@pytest.mark.asyncio
async def test_touch_error_does_not_leak_the_host_path(workspace, tmp_path):
    io = await workspace.execute("touch /missing/f.txt")
    assert str(tmp_path).encode() not in (io.stderr or b"")


@pytest.mark.asyncio
async def test_touch_keeps_going_after_a_failed_operand(workspace):
    io = await workspace.execute("touch /ok1.txt /missing/f.txt /ok2.txt")
    assert io.exit_code == 1
    listing = await workspace.execute("ls /")
    assert b"ok1.txt" in listing.stdout
    assert b"ok2.txt" in listing.stdout


@pytest.mark.asyncio
async def test_redirect_into_missing_parent_does_not_create_it(
        workspace, tmp_path):
    io = await workspace.execute("echo hi > /missing/f.txt")
    assert io.exit_code == 1
    assert io.stderr == b"/missing/f.txt: No such file or directory\n"
    assert not (tmp_path / "missing").exists()


@pytest.mark.asyncio
async def test_append_into_missing_parent_does_not_create_it(
        workspace, tmp_path):
    io = await workspace.execute("echo hi >> /missing/f.txt")
    assert io.exit_code == 1
    assert io.stderr == b"/missing/f.txt: No such file or directory\n"
    assert not (tmp_path / "missing").exists()
