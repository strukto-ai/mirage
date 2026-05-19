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
async def test_wc_default(workspace):
    await workspace.ops.write("/f.txt", b"hello world\nfoo bar\n")
    io = await workspace.execute("wc /f.txt", session_id="default")
    assert io.exit_code == 0
    parts = io.stdout.decode().split("\t")
    assert parts[0] == "2"
    assert parts[1] == "4"
    assert parts[2] == "20"
    assert parts[3] == "/f.txt"


@pytest.mark.asyncio
async def test_wc_l(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\n")
    io = await workspace.execute("wc -l /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout.decode().split("\t")[0] == "3"


@pytest.mark.asyncio
async def test_wc_w(workspace):
    await workspace.ops.write("/f.txt", b"hello world\nfoo\n")
    io = await workspace.execute("wc -w /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout.decode().split("\t")[0] == "3"


@pytest.mark.asyncio
async def test_wc_c(workspace):
    await workspace.ops.write("/f.txt", b"hello\n")
    io = await workspace.execute("wc -c /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout.decode().split("\t")[0] == "6"


@pytest.mark.asyncio
async def test_wc_m_multibyte(workspace):
    await workspace.ops.write("/f.txt", "café".encode())
    io = await workspace.execute("wc -m /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout.decode().split("\t")[0] == "4"


@pytest.mark.asyncio
async def test_wc_L(workspace):
    await workspace.ops.write("/f.txt", b"short\na much longer line\nmed\n")
    io = await workspace.execute("wc -L /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout.decode().split("\t")[0] == str(len("a much longer line"))


@pytest.mark.asyncio
async def test_wc_empty_file(workspace):
    await workspace.ops.write("/f.txt", b"")
    io = await workspace.execute("wc /f.txt", session_id="default")
    assert io.exit_code == 0
    parts = io.stdout.decode().split("\t")
    assert parts[:3] == ["0", "0", "0"]


@pytest.mark.asyncio
async def test_wc_multi_file_emits_total(workspace):
    await workspace.ops.write("/a.txt", b"hello\n")
    await workspace.ops.write("/b.txt", b"world\nfoo\n")
    io = await workspace.execute("wc /a.txt /b.txt", session_id="default")
    assert io.exit_code == 0
    lines = io.stdout.decode().splitlines()
    assert any(line.endswith("/a.txt") for line in lines)
    assert any(line.endswith("/b.txt") for line in lines)
    assert lines[-1].endswith("total")
