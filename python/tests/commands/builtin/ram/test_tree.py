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
async def test_tree_basic(workspace):
    await workspace.ops.mkdir("/d1")
    await workspace.ops.write("/d1/a.txt", b"a")
    await workspace.ops.write("/d1/b.txt", b"b")
    io = await workspace.execute("tree /d1")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "a.txt" in out
    assert "b.txt" in out


@pytest.mark.asyncio
async def test_tree_L_max_depth(workspace):
    await workspace.ops.mkdir("/d1")
    await workspace.ops.mkdir("/d1/sub")
    await workspace.ops.mkdir("/d1/sub/deep")
    await workspace.ops.write("/d1/sub/deep/file.txt", b"d")
    io = await workspace.execute("tree -L 1 /d1")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "deep" in out
    assert "file.txt" not in out


@pytest.mark.asyncio
async def test_tree_a_shows_dotfiles(workspace):
    await workspace.ops.mkdir("/d1")
    await workspace.ops.write("/d1/.hidden", b"h")
    await workspace.ops.write("/d1/visible.txt", b"v")
    io = await workspace.execute("tree -a /d1")
    assert io.exit_code == 0
    assert ".hidden" in io.stdout.decode()


@pytest.mark.asyncio
async def test_tree_d_dirs_only(workspace):
    await workspace.ops.mkdir("/d1")
    await workspace.ops.mkdir("/d1/sub")
    await workspace.ops.write("/d1/file.txt", b"x")
    io = await workspace.execute("tree -d /d1")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "sub" in out
    assert "file.txt" not in out
