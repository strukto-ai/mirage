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


async def _seed(workspace):
    await workspace.fs.mkdir("/sub")
    await workspace.fs.write("/a.txt", b"hello\n")
    await workspace.fs.write("/sub/b.txt", b"hello\n")
    return workspace


@pytest.mark.asyncio
async def test_find_bare_walks_the_cwd(workspace):
    seeded = await _seed(workspace)
    # GNU find with no path operand behaves exactly as `find .`; the
    # implicit dev/history mounts ride along dot-spelled, interleaved
    # at their path-sorted position (the fan-out merge sorts so a
    # mount root prints before its contents).
    io = await seeded.execute("find", cwd="/")
    assert io.exit_code == 0
    out = (io.stdout or b"").decode()
    lines = out.strip().split("\n")
    assert lines == sorted(lines)
    assert all(line.startswith(".") for line in lines)
    assert {".", "./a.txt", "./sub", "./sub/b.txt"} <= set(lines)


@pytest.mark.asyncio
async def test_find_bare_with_expression(workspace):
    seeded = await _seed(workspace)
    # `find -name x` is `find . -name x`; the implied `.` goes before
    # the expression.
    io = await seeded.execute("find -name '*.txt'", cwd="/")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"./a.txt\n./sub/b.txt\n"


@pytest.mark.asyncio
async def test_tree_bare_renders_the_cwd(workspace):
    seeded = await _seed(workspace)
    io = await seeded.execute("tree", cwd="/")
    assert io.exit_code == 0
    assert (io.stdout or b"").startswith(b".\n")
    assert b"a.txt" in (io.stdout or b"")


@pytest.mark.asyncio
async def test_du_bare_measures_the_cwd_dot_spelled(workspace):
    seeded = await _seed(workspace)
    # GNU du with no operand prints ./-spelled rows ending in `.`
    # (sizes are bytes, mirage's documented divergence from blocks);
    # the implicit /dev child mount rides along as ./dev, in its
    # post-order position rather than appended, and keeps GNU's `0` row
    # even though it holds nothing. Pinned on coreutils 9.7 with a tmpfs
    # at ./dev: `0 ./dev`, `6 ./sub`, `12 .`.
    io = await seeded.execute("du", cwd="/")
    assert io.exit_code == 0
    assert (io.stdout or b"") == b"0\t./dev\n6\t./sub\n12\t.\n"


@pytest.mark.asyncio
async def test_ls_recursive_bare_uses_dot_headers(workspace):
    seeded = await _seed(workspace)
    io = await seeded.execute("ls -R", cwd="/")
    assert io.exit_code == 0
    out = (io.stdout or b"").decode()
    assert out.startswith(".:\n")
    assert "\n./sub:\n" in out


@pytest.mark.asyncio
async def test_ls_bare_still_lists_the_cwd(workspace):
    seeded = await _seed(workspace)
    io = await seeded.execute("ls", cwd="/")
    assert io.exit_code == 0
    out = (io.stdout or b"").decode()
    # The dev mount is a row like any other now, so it sorts into the
    # listing instead of trailing it the way the old stdout patch did.
    assert out.startswith("a.txt\ndev\nsub")
