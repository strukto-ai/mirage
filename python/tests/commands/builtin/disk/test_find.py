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
    return Workspace({"/": DiskResource(root=str(tmp_path))},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_find_name_glob(workspace):
    await workspace.fs.write("/hello.txt", b"hi")
    await workspace.fs.write("/world.py", b"hi")
    io = await workspace.execute("find / -name '*.txt'")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "hello.txt" in out
    assert "world.py" not in out


@pytest.mark.asyncio
async def test_find_type_f(workspace):
    await workspace.fs.mkdir("/sub")
    await workspace.fs.write("/a.txt", b"a")
    await workspace.fs.write("/sub/b.txt", b"b")
    io = await workspace.execute("find / -type f")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "/a.txt" in out
    assert "/sub/b.txt" in out


@pytest.mark.asyncio
async def test_find_type_d(workspace):
    await workspace.fs.mkdir("/sub")
    await workspace.fs.write("/a.txt", b"a")
    io = await workspace.execute("find / -type d")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "/sub" in out
    assert "/a.txt" not in out


@pytest.mark.asyncio
async def test_find_size_lower_bound(workspace):
    await workspace.fs.write("/big.txt", b"x" * 1000)
    await workspace.fs.write("/small.txt", b"x")
    io = await workspace.execute("find / -size +500c -type f")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "big.txt" in out
    assert "small.txt" not in out


@pytest.mark.asyncio
async def test_find_maxdepth(workspace):
    await workspace.fs.mkdir("/sub")
    await workspace.fs.mkdir("/sub/deep")
    await workspace.fs.write("/a.txt", b"a")
    await workspace.fs.write("/sub/deep/c.txt", b"c")
    io = await workspace.execute("find / -maxdepth 1 -type f")
    assert io.exit_code == 0
    out = io.stdout.decode()
    assert "/a.txt" in out
    assert "/sub/deep/c.txt" not in out
