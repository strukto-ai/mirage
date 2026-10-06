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

from mirage import RAMVFS, MountMode, Workspace


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operands,deep",
    [
        ("/a.txt /plain/s/x.txt", "/plain/s/x.txt"),
        ("/plain/a/b /d", "/plain/a/b"),
    ],
)
async def test_cp_deep_under_a_file_reports_not_a_directory(
    workspace, operands, deep
):
    await workspace.vfs.write("/a.txt", b"hi")
    await workspace.vfs.write("/plain", b"y")
    await workspace.vfs.mkdir("/d")
    io = await workspace.shell(f"cp {operands}")
    assert io.exit_code == 1
    assert io.stderr == f"cp: cannot stat '{deep}': Not a directory\n".encode()


@pytest.mark.asyncio
async def test_cp_recursive_verbose_lists_directories(workspace):
    await workspace.vfs.mkdir("/dir")
    await workspace.vfs.mkdir("/dir/sub")
    await workspace.vfs.write("/dir/f.txt", b"f")
    await workspace.vfs.write("/dir/sub/g.txt", b"g")
    io = await workspace.shell("cp -rv /dir /newdir")
    assert io.exit_code == 0
    lines = io.stdout.decode().splitlines()
    # GNU prints directories as well as files, parents before children.
    assert "'/dir' -> '/newdir'" in lines
    assert "'/dir/sub' -> '/newdir/sub'" in lines
    assert lines.index("'/dir' -> '/newdir'") < lines.index(
        "'/dir/sub' -> '/newdir/sub'"
    )
    assert lines.index("'/dir/sub' -> '/newdir/sub'") < lines.index(
        "'/dir/sub/g.txt' -> '/newdir/sub/g.txt'"
    )
