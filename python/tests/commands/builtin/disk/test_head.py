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
async def test_head_default_n_10(workspace):
    body = b"".join(f"line{i}\n".encode() for i in range(1, 15))
    await workspace.ops.write("/f.txt", body)
    io = await workspace.execute("head /f.txt", session_id="default")
    assert io.exit_code == 0
    lines = io.stdout.decode().splitlines()
    assert len(lines) == 10
    assert lines[0] == "line1"
    assert lines[9] == "line10"


@pytest.mark.asyncio
async def test_head_n_explicit(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\nd\n")
    io = await workspace.execute("head -n 2 /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"a\nb\n"


@pytest.mark.asyncio
async def test_head_c_bytes(workspace):
    await workspace.ops.write("/f.txt", b"hello world")
    io = await workspace.execute("head -c 5 /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"hello"


@pytest.mark.asyncio
async def test_head_negative_n_excludes_last(workspace):
    await workspace.ops.write("/f.txt", b"a\nb\nc\nd\n")
    io = await workspace.execute("head -n -1 /f.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_head_no_trailing_newline(workspace):
    await workspace.ops.write("/partial.txt", b"hello")
    io = await workspace.execute("head /partial.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b"hello"


@pytest.mark.asyncio
async def test_head_empty_file(workspace):
    await workspace.ops.write("/empty.txt", b"")
    io = await workspace.execute("head /empty.txt", session_id="default")
    assert io.exit_code == 0
    assert io.stdout == b""
