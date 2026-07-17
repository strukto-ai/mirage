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
    await workspace.ops.write("/a.txt", b"keep")
    io = await workspace.execute("mv /a.txt /a.txt")
    assert io.exit_code != 0
    assert b"are the same file" in io.stderr
    assert await workspace.ops.read("/a.txt") == b"keep"


@pytest.mark.asyncio
async def test_mv_into_own_subtree_refused(workspace):
    await workspace.ops.mkdir("/d")
    await workspace.ops.write("/d/a.txt", b"a")
    await workspace.ops.mkdir("/d/sub")
    io = await workspace.execute("mv /d /d/sub")
    assert io.exit_code != 0
    assert b"subdirectory of itself" in io.stderr
    assert await workspace.ops.read("/d/a.txt") == b"a"


@pytest.mark.asyncio
async def test_mv_missing_source_reports_cannot_stat(workspace):
    io = await workspace.execute("mv /missing.txt /dst.txt")
    assert io.exit_code != 0
    assert b"mv: cannot stat" in io.stderr
