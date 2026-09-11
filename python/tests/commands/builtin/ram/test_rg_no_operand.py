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
async def test_rg_no_operand_searches_cwd(workspace):
    # ripgrep with no path operand and no attached stdin searches the
    # cwd recursively and prints bare relative names (ripgrep 14).
    await workspace.fs.mkdir("/sub")
    await workspace.fs.write("/a.txt", b"hello\n")
    await workspace.fs.write("/sub/b.txt", b"hello\n")

    io = await workspace.execute("rg hello", cwd="/")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"a.txt:hello\nsub/b.txt:hello\n"


@pytest.mark.asyncio
async def test_rg_no_operand_attached_stdin_wins(workspace):
    # A piped stdin, even empty, wins over the cwd search (rg's
    # readable-stdin rule).
    await workspace.fs.write("/a.txt", b"hello\n")

    io = await workspace.execute("rg hello", cwd="/", stdin=b"hello pipe\n")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"hello pipe\n"

    io = await workspace.execute("rg hello", cwd="/", stdin=b"")
    assert io.exit_code == 1
    assert (io.stdout or b"") == b""


@pytest.mark.asyncio
async def test_rg_no_operand_no_match_exits_one(workspace):
    await workspace.fs.write("/a.txt", b"hello\n")

    io = await workspace.execute("rg zzz", cwd="/")
    assert io.exit_code == 1
    assert (io.stdout or b"") == b""
    assert not io.stderr
