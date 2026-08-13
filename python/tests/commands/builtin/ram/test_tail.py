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
async def test_tail_default_n_10(workspace):
    body = b"\n".join(f"line{i}".encode() for i in range(1, 21)) + b"\n"
    await workspace.ops.write("/f.txt", body)
    io = await workspace.execute("tail /f.txt")
    assert io.exit_code == 0
    expected = b"\n".join(f"line{i}".encode() for i in range(11, 21)) + b"\n"
    assert io.stdout == expected


@pytest.mark.asyncio
async def test_tail_n_explicit(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\nd\ne\n")
    io = await workspace.execute("tail -n 3 /f.txt")
    assert io.exit_code == 0
    assert io.stdout == b"c\nd\ne\n"


@pytest.mark.asyncio
async def test_tail_c_bytes(workspace):
    await workspace.ops.write("/f.txt", b"hello world")
    io = await workspace.execute("tail -c 5 /f.txt")
    assert io.exit_code == 0
    assert io.stdout == b"world"


@pytest.mark.asyncio
async def test_tail_plus_n_streams_from_line(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\nd\ne\n")
    io = await workspace.execute("tail -n +3 /f.txt")
    assert io.exit_code == 0
    assert io.stdout == b"c\nd\ne\n"


@pytest.mark.asyncio
async def test_tail_no_trailing_newline(workspace):
    await workspace.ops.write("/partial.txt", b"hello")
    io = await workspace.execute("tail /partial.txt")
    assert io.exit_code == 0
    assert io.stdout == b"hello"


@pytest.mark.asyncio
async def test_tail_empty_file(workspace):
    await workspace.ops.write("/empty.txt", b"")
    io = await workspace.execute("tail /empty.txt")
    assert io.exit_code == 0
    assert io.stdout == b""


@pytest.mark.asyncio
async def test_tail_multi_file_emits_headers(workspace):
    await workspace.ops.write("/a.txt", b"x\ny\n")
    await workspace.ops.write("/b.txt", b"z\n")
    io = await workspace.execute("tail /a.txt /b.txt")
    assert io.exit_code == 0
    assert b"==> /a.txt <==" in io.stdout
    assert b"==> /b.txt <==" in io.stdout


@pytest.mark.asyncio
async def test_tail_q_suppresses_headers(workspace):
    await workspace.ops.write("/a.txt", b"x\n")
    await workspace.ops.write("/b.txt", b"y\n")
    io = await workspace.execute("tail -q /a.txt /b.txt")
    assert io.exit_code == 0
    assert b"==>" not in io.stdout
    assert b"x\n" in io.stdout
    assert b"y\n" in io.stdout


@pytest.mark.asyncio
async def test_tail_v_forces_header_on_single_file(workspace):
    await workspace.ops.write("/a.txt", b"aaa\n")
    io = await workspace.execute("tail -v /a.txt")
    assert io.exit_code == 0
    assert b"==> /a.txt <==" in io.stdout
    assert b"aaa\n" in io.stdout
