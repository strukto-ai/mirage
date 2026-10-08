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

import errno
from unittest.mock import AsyncMock

import pytest

from mirage.types import FileStat, FileType, MountMode
from mirage.vfs.base import BaseVFS
from mirage.workspace.mount.mount import MountEntry

# What the op door does around a VFS's functions: a read takes a window,
# append and pwrite are a rewrite where the VFS only writes whole files,
# a pwrite offset is checked, and mkdir refuses a taken name first.

PATH = "/x/a.txt"


class _S3Error(Exception):
    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.response = {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status},
        }


def _mount(reads_ranges: bool = False, **fns: AsyncMock) -> MountEntry:
    fns.setdefault("stat", AsyncMock())
    fns.setdefault("readdir", AsyncMock(return_value=[PATH]))
    fns.setdefault("read", AsyncMock(return_value=b"data"))
    cls = type(
        "Store", (BaseVFS,), {"name": "x", "reads_ranges": reads_ranges, **fns}
    )
    return MountEntry("/x/", cls(), mode=MountMode.WRITE)


def _written(write: AsyncMock) -> list[bytes]:
    return [call.args[1] for call in write.await_args_list]


@pytest.mark.asyncio
async def test_a_whole_file_read_never_asks_for_a_range():
    mount = _mount()
    assert await mount.call("read", PATH) == b"data"
    assert mount.vfs.read.await_args.kwargs == {"index": mount.index}


@pytest.mark.asyncio
async def test_a_vfs_without_ranges_reads_and_slices():
    # Correct everywhere, and the only meaningful answer for a backend
    # that renders its bytes rather than storing them.
    mount = _mount()
    assert await mount.call("read", PATH, offset=1, size=2) == b"at"
    assert await mount.call("read", PATH, offset=2) == b"ta"


@pytest.mark.asyncio
async def test_a_native_range_is_asked_for_the_window_only():
    # On an object store this is one ranged GET rather than fetching the
    # object and throwing most of it away.
    mount = _mount(reads_ranges=True, read=AsyncMock(return_value=b"ng"))
    assert await mount.call("read", PATH, offset=1, size=2) == b"ng"
    assert mount.vfs.read.await_args.kwargs == {
        "index": mount.index,
        "offset": 1,
        "size": 2,
    }
    await mount.call("read", PATH)
    assert mount.vfs.read.await_args.kwargs == {"index": mount.index}


@pytest.mark.asyncio
async def test_a_window_past_the_end_reads_empty_not_416():
    # A POSIX read at or past EOF is short, not an error. An HTTP store
    # refuses instead; normalizing here keeps the op one thing either way.
    read = AsyncMock(side_effect=_S3Error("InvalidRange", 416))
    mount = _mount(reads_ranges=True, read=read)
    assert await mount.call("read", PATH, offset=99, size=2) == b""
    read.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_range_read_that_failed_for_a_real_reason_propagates():
    read = AsyncMock(side_effect=_S3Error("AccessDenied", 403))
    mount = _mount(reads_ranges=True, read=read)
    with pytest.raises(_S3Error):
        await mount.call("read", PATH, offset=1, size=2)


@pytest.mark.asyncio
@pytest.mark.parametrize("reads_ranges", [True, False])
async def test_a_zero_length_read_asks_the_vfs_nothing(reads_ranges):
    # No store can express an empty range, and the answer is known.
    mount = _mount(reads_ranges=reads_ranges)
    assert await mount.call("read", PATH, offset=1, size=0) == b""
    mount.vfs.read.assert_not_awaited()


@pytest.mark.asyncio
async def test_append_is_a_rewrite_where_the_vfs_only_writes():
    write = AsyncMock()
    mount = _mount(write=write)
    await mount.call("append", PATH, b"new")
    assert _written(write) == [b"datanew"]
    assert mount.vfs.read.await_args.kwargs == {"index": mount.index}


@pytest.mark.asyncio
async def test_a_native_append_skips_the_rewrite():
    write = AsyncMock()
    append = AsyncMock()
    mount = _mount(write=write, append=append)
    await mount.call("append", PATH, b"new")
    assert append.await_args.args[1] == b"new"
    mount.vfs.read.assert_not_awaited()
    write.assert_not_awaited()


@pytest.mark.asyncio
async def test_pwrite_is_a_rewrite_where_the_vfs_only_writes():
    write = AsyncMock()
    mount = _mount(write=write)
    await mount.call("pwrite", PATH, b"XY", 1)
    assert _written(write) == [b"dXYa"]


@pytest.mark.asyncio
async def test_a_native_pwrite_gets_the_offset_and_index():
    write = AsyncMock()
    pwrite = AsyncMock()
    mount = _mount(write=write, pwrite=pwrite)
    await mount.call("pwrite", PATH, b"XY", 3)
    assert pwrite.await_args.args[1:] == (b"XY", 3)
    assert pwrite.await_args.kwargs == {"index": mount.index}
    mount.vfs.read.assert_not_awaited()
    write.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("native", [True, False])
async def test_pwrite_refuses_a_negative_offset_before_any_io(native):
    write = AsyncMock()
    fns = {"write": write}
    if native:
        fns["pwrite"] = AsyncMock()
    mount = _mount(**fns)
    with pytest.raises(OSError) as exc:
        await mount.call("pwrite", PATH, b"Z", -1)
    assert exc.value.errno == errno.EINVAL
    mount.vfs.read.assert_not_awaited()
    write.assert_not_awaited()
    if native:
        fns["pwrite"].assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kind", "parents", "refused"),
    [
        (FileType.DIRECTORY, False, True),
        (FileType.FILE, False, True),
        (FileType.FILE, True, True),
        (FileType.DIRECTORY, True, False),
    ],
)
async def test_mkdir_refuses_a_taken_name_before_the_create(
    kind, parents, refused
):
    """A VFS whose create passes a taken name still answers EEXIST."""
    mkdir = AsyncMock()
    stat = AsyncMock(return_value=FileStat(name="a.txt", type=kind))
    mount = _mount(mkdir=mkdir, stat=stat)
    if refused:
        with pytest.raises(FileExistsError):
            await mount.call("mkdir", PATH, parents=parents)
        mkdir.assert_not_awaited()
    else:
        await mount.call("mkdir", PATH, parents=parents)
        assert mkdir.await_args.kwargs == {"parents": True}
