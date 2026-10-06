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

from mirage.commands.builtin.generic.csplit import csplit_generic
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


async def _no_read(path: PathSpec) -> bytes:
    raise AssertionError(f"read {path.virtual}: the input is stdin")


async def _no_unlink(path: PathSpec) -> None:
    raise AssertionError(f"unlink {path.virtual}: the run succeeds")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cwd,prefix,named",
    [
        ("/data", "xx", ["/data/xx00", "/data/xx01"]),
        ("/data/sub", "xx", ["/data/sub/xx00", "/data/sub/xx01"]),
        (
            "/",
            PathSpec(
                virtual="/data/sub/cs",
                directory="/data/sub/",
                vfs_path="sub/cs",
            ),
            ["/data/sub/cs00", "/data/sub/cs01"],
        ),
    ],
)
async def test_stdin_outputs_are_named_on_the_executing_mount(
    cwd: str, prefix: str | PathSpec, named: list[str]
):
    # With no -f, `xx` in the working directory names the outputs (GNU);
    # a -f path names them by its virtual path. The writes keys stay
    # mount-relative.
    specs: list[PathSpec] = []

    async def write_bytes(path: PathSpec, data: bytes) -> None:
        specs.append(path)

    _, io = await csplit_generic(
        [],
        ["2"],
        read_bytes=_no_read,
        write_bytes=write_bytes,
        unlink=_no_unlink,
        stdin=b"a\nb\n",
        prefix=prefix,
        mount_prefix="/data",
        cwd=cwd,
    )
    assert [p.virtual for p in specs] == named
    assert list(io.writes) == [name[len("/data") :] for name in named]


@pytest.mark.asyncio
async def test_dev_stdin_stays_a_path_so_no_piece_lands_in_dev():
    # /dev/stdin runs csplit on the /dev mount, where its pieces would be
    # written, so it is refused as a missing path rather than read.
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    r = await ws.shell("cd /data && csplit /dev/stdin 2", stdin=b"a\nb\nc\n")
    assert r.exit_code == 1
    assert await r.materialize_stderr() == (
        b"csplit: cannot open '/dev/stdin' for reading: "
        b"No such file or directory\n"
    )
    listing = await ws.shell("ls /dev")
    assert b"xx00" not in (await listing.materialize_stdout() or b"")
