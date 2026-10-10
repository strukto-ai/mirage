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

from mirage.core.generic.rewrite import (
    append_by_rewrite,
    expect_offset,
    pwrite_by_rewrite,
    refuse_taken,
    truncate_by_rewrite,
)
from mirage.types import FileStat, FileType, PathSpec

PATH = PathSpec.from_str_path("/x/a.txt", "a.txt")


def _file(kind: FileType = FileType.FILE) -> FileStat:
    return FileStat(name="a.txt", type=kind)


@pytest.mark.asyncio
async def test_append_reads_current_bytes_and_creates_missing():
    read = AsyncMock(side_effect=[b"old", b"oldnew", FileNotFoundError()])
    write = AsyncMock()
    for data in (b"new", b"!", b"created"):
        await append_by_rewrite(read, write, AsyncMock(), PATH, data)
    assert [call.args[1] for call in write.await_args_list] == [
        b"oldnew",
        b"oldnew!",
        b"created",
    ]


@pytest.mark.asyncio
async def test_append_does_not_overwrite_after_a_failed_read():
    read = AsyncMock(side_effect=PermissionError(PATH.virtual))
    write = AsyncMock()
    with pytest.raises(PermissionError):
        await append_by_rewrite(read, write, AsyncMock(), PATH, b"new")
    write.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("by_rewrite", ["append", "pwrite"])
async def test_an_empty_write_stats_instead_of_rewriting(by_rewrite):
    read = AsyncMock()
    write = AsyncMock()
    stat = AsyncMock(
        side_effect=[
            _file(),
            FileNotFoundError(),
            _file(FileType.DIRECTORY),
        ]
    )

    async def run() -> None:
        if by_rewrite == "append":
            await append_by_rewrite(read, write, stat, PATH, b"")
        else:
            await pwrite_by_rewrite(read, write, stat, PATH, b"", 0)

    await run()
    write.assert_not_awaited()
    await run()
    write.assert_awaited_once_with(PATH, b"")
    with pytest.raises(IsADirectoryError):
        await run()
    read.assert_not_awaited()
    assert write.await_count == 1


@pytest.mark.asyncio
async def test_pwrite_splices_pads_and_creates_missing():
    read = AsyncMock(side_effect=[b"hello", b"ab", FileNotFoundError()])
    stat = AsyncMock(side_effect=FileNotFoundError())
    write = AsyncMock()
    for data, offset in ((b"XY", 1), (b"z", 4), (b"new", 2)):
        await pwrite_by_rewrite(read, write, stat, PATH, data, offset)
    assert [call.args[1] for call in write.await_args_list] == [
        b"hXYlo",
        b"ab\0\0z",
        b"\0\0new",
    ]


@pytest.mark.asyncio
async def test_pwrite_keeps_a_failed_read():
    read = AsyncMock(side_effect=PermissionError(PATH.virtual))
    write = AsyncMock()
    with pytest.raises(PermissionError):
        await pwrite_by_rewrite(read, write, AsyncMock(), PATH, b"new", 0)
    write.assert_not_awaited()


@pytest.mark.asyncio
async def test_pwrite_never_writes_beside_a_directory():
    # A key store answers a read of a directory's name as a missing key.
    read = AsyncMock(side_effect=FileNotFoundError())
    stat = AsyncMock(return_value=_file(FileType.DIRECTORY))
    write = AsyncMock()
    with pytest.raises(IsADirectoryError):
        await pwrite_by_rewrite(read, write, stat, PATH, b"new", 0)
    write.assert_not_awaited()


def test_a_negative_offset_is_einval():
    assert expect_offset(3, PATH) == 3
    with pytest.raises(OSError) as exc:
        expect_offset(-1, PATH)
    assert exc.value.errno == errno.EINVAL


@pytest.mark.asyncio
async def test_truncate_pads_and_cuts():
    write = AsyncMock()
    read = AsyncMock(return_value=b"data")
    await truncate_by_rewrite(read, write, PATH, 6, False)
    assert write.await_args.args[1] == b"data\0\0"
    await truncate_by_rewrite(read, write, PATH, 2, False)
    assert write.await_args.args[1] == b"da"


@pytest.mark.asyncio
async def test_truncate_of_a_missing_file_pads_zeros():
    write = AsyncMock()
    read = AsyncMock(side_effect=FileNotFoundError(PATH.virtual))
    await truncate_by_rewrite(read, write, PATH, 3, False)
    assert write.await_args.args[1] == b"\0\0\0"


@pytest.mark.asyncio
async def test_truncate_refuses_no_create_before_io():
    read = AsyncMock()
    write = AsyncMock()
    with pytest.raises(OSError) as error:
        await truncate_by_rewrite(read, write, PATH, 2, True)
    assert error.value.errno == errno.ENOTSUP
    read.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_truncate_refuses_a_negative_length_before_io():
    read = AsyncMock()
    write = AsyncMock()
    with pytest.raises(OSError) as error:
        await truncate_by_rewrite(read, write, PATH, -1, False)
    assert error.value.errno == errno.EINVAL
    read.assert_not_called()
    write.assert_not_called()


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
async def test_refuse_taken(kind, parents, refused):
    """A directory under ``-p`` passes on to the create, which writes the
    marker an implied object-store directory lacks."""
    stat = AsyncMock(return_value=_file(kind))
    if refused:
        with pytest.raises(FileExistsError):
            await refuse_taken(stat, PATH, parents)
    else:
        await refuse_taken(stat, PATH, parents)


@pytest.mark.asyncio
async def test_refuse_taken_leaves_a_missing_name_to_the_create():
    await refuse_taken(AsyncMock(side_effect=FileNotFoundError()), PATH, False)
