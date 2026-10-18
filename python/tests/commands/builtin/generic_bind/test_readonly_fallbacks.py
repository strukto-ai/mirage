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

from mirage.types import MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.mount_commands import run_on_mount


class _ReadOnlyRAM(RAMVFS):
    """A RAM store with no write-side function and no one-call walk, as
    a read-only service is."""

    write = BaseVFS.write
    append = BaseVFS.append
    pwrite = BaseVFS.pwrite
    truncate = BaseVFS.truncate
    read_tree = BaseVFS.read_tree


def _ws() -> Workspace:
    vfs = _ReadOnlyRAM()
    vfs._store.dirs.update({"/", "/sub"})
    vfs._store.files.update({"/a.txt": b"alpha\n", "/sub/b.txt": b"bravo\n"})
    return Workspace({"/g/": (vfs, MountMode.WRITE)})


def _spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


@pytest.mark.asyncio
async def test_find_walks_tree_without_native_find_op():
    out, io = await run_on_mount(
        _ws(), "find", [_spec("/g")], flags={"type": "f"}
    )
    text = out.decode()
    assert "/g/a.txt" in text
    assert "/g/sub/b.txt" in text
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_du_walks_tree_without_native_du_op():
    out, _ = await run_on_mount(_ws(), "du", [_spec("/g")], flags={"s": True})
    text = out.decode()
    # alpha\n (6) + bravo\n (6) = 12 bytes summed by the readdir walk.
    assert "12" in text
    assert "/g" in text


@pytest.mark.asyncio
async def test_shuf_reads_without_a_write_op():
    out, io = await run_on_mount(_ws(), "shuf", [_spec("/g/a.txt")])
    assert out.decode() == "alpha\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_shuf_output_flag_names_the_missing_write_op():
    # The mount words its command's failure, as it words any other.
    out, io = await run_on_mount(
        _ws(),
        "shuf",
        [_spec("/g/a.txt")],
        flags={"output": _spec("/g/out.txt")},
    )
    assert out == b""
    assert (io.exit_code, io.stderr) == (
        1,
        b"shuf: backend provides no write op\n",
    )
