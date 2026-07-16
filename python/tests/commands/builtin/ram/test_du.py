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
async def test_du_single_file(workspace):
    await workspace.ops.write("/f.txt", b"hello")
    io = await workspace.execute("du /f.txt")
    assert io.exit_code == 0
    assert io.stdout.decode().strip() == "5\t/f.txt"


@pytest.mark.asyncio
async def test_du_directory_collapses(workspace):
    await workspace.ops.mkdir("/dir")
    await workspace.ops.write("/dir/a.txt", b"aaa")
    await workspace.ops.write("/dir/b.txt", b"bb")
    io = await workspace.execute("du /dir")
    assert io.exit_code == 0
    assert io.stdout.decode().strip() == "5\t/dir"


@pytest.mark.asyncio
async def test_du_a_lists_files(workspace):
    await workspace.ops.mkdir("/dir")
    await workspace.ops.write("/dir/a.txt", b"aaa")
    await workspace.ops.write("/dir/b.txt", b"bb")
    io = await workspace.execute("du -a /dir")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "a.txt" in out
    assert "b.txt" in out


@pytest.mark.asyncio
async def test_du_s_summary(workspace):
    await workspace.ops.mkdir("/dir")
    await workspace.ops.mkdir("/dir/sub")
    await workspace.ops.write("/dir/a.txt", b"hello")
    await workspace.ops.write("/dir/sub/b.txt", b"world")
    io = await workspace.execute("du -s /dir")
    assert io.exit_code == 0
    lines = io.stdout.decode().strip().splitlines()
    assert len(lines) == 1


@pytest.mark.asyncio
async def test_du_c_total(workspace):
    await workspace.ops.write("/a.txt", b"hello")
    await workspace.ops.write("/b.txt", b"world")
    io = await workspace.execute("du -c /a.txt /b.txt")
    assert io.exit_code == 0
    lines = io.stdout.decode().strip().splitlines()
    assert lines[-1] == "10\ttotal"


@pytest.mark.asyncio
async def test_du_h_human(workspace):
    await workspace.ops.write("/big.txt", b"x" * 2048)
    io = await workspace.execute("du -h /big.txt")
    assert io.exit_code == 0
    size_str = io.stdout.decode().strip().split("\t")[0]
    assert size_str.endswith("K")


@pytest.mark.asyncio
async def test_du_max_depth_one(workspace):
    await workspace.ops.mkdir("/dir")
    await workspace.ops.mkdir("/dir/sub")
    await workspace.ops.mkdir("/dir/sub/deep")
    await workspace.ops.write("/dir/sub/deep/a.txt", b"hello")
    io = await workspace.execute("du -a --max-depth 1 /dir")
    assert io.exit_code == 0
    lines = io.stdout.decode().strip().splitlines()
    assert not any("deep" in ln for ln in lines)


@pytest.mark.asyncio
async def test_du_missing_operand_errors(workspace):
    io = await workspace.execute("du")
    assert io.exit_code != 0
    assert b"missing operand" in (io.stderr or b"")
