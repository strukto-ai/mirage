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
async def test_rg_dash_e_matches_like_positional_pattern(workspace):
    await workspace.ops.mkdir("/data")
    await workspace.ops.write("/data/a.txt", b"orange line\nplain line\n")

    io = await workspace.execute("rg -e orange /data/a.txt")
    assert io.exit_code == 0
    assert "orange line" in (io.stdout or b"").decode()


@pytest.mark.asyncio
async def test_rg_repeated_dash_e_matches_any_pattern(workspace):
    await workspace.ops.mkdir("/data")
    await workspace.ops.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")

    io = await workspace.execute("rg -e orange -e plain /data/a.txt")
    assert io.exit_code == 0
    out = (io.stdout or b"").decode()
    assert "orange line" in out
    assert "plain line" in out
    assert "last line" not in out


@pytest.mark.asyncio
async def test_rg_dash_f_reads_patterns_from_file(workspace):
    await workspace.ops.mkdir("/data")
    await workspace.ops.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")
    await workspace.ops.write("/data/pats.txt", b"orange\nlast\n")

    io = await workspace.execute("rg -f /data/pats.txt /data/a.txt")
    assert io.exit_code == 0
    out = (io.stdout or b"").decode()
    assert "orange line" in out
    assert "last line" in out
    assert "plain line" not in out


@pytest.mark.asyncio
async def test_rg_dash_e_and_dash_f_union(workspace):
    await workspace.ops.mkdir("/data")
    await workspace.ops.write("/data/a.txt",
                              b"orange line\nplain line\nlast line\n")
    await workspace.ops.write("/data/pats.txt", b"last\n")

    io = await workspace.execute("rg -e plain -f /data/pats.txt /data/a.txt")
    assert io.exit_code == 0
    out = (io.stdout or b"").decode()
    assert "plain line" in out
    assert "last line" in out
