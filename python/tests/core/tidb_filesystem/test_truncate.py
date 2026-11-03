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

from mirage.core.tidb_filesystem.errors import TiDBFilesystemApiError
from mirage.core.tidb_filesystem.truncate import truncate
from mirage.errors.types import OperationNotSupportedError
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

MIB = 1024 * 1024


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/fs"))


def _big(size: int) -> bytes:
    return bytes(range(256)) * (size // 256) + bytes(size % 256)


@pytest.mark.asyncio
async def test_a_large_file_is_cut_moving_only_the_last_part(accessor, drive9):
    data = _big(9 * MIB)
    drive9.files["/root/big.bin"] = data

    scope = RecordingScope()
    try:
        await truncate(accessor, _path("/fs/big.bin"), 8 * MIB + 5)
    finally:
        scope.close()

    assert drive9.files["/root/big.bin"] == data[: 8 * MIB + 5]
    assert drive9.count("PUT", "/s3/upload") == 1
    assert drive9.count("GET", "/s3/objects") == 1
    assert drive9.count("GET", "/root") == 0
    assert drive9.count("PUT", "/root") == 0
    assert [(r.op, r.path) for r in scope.records] == [
        ("truncate", "/fs/big.bin")
    ]


@pytest.mark.asyncio
async def test_a_large_file_cut_below_the_inline_size_keeps_its_head(
    accessor, drive9
):
    data = _big(60_000)
    drive9.files["/root/big.bin"] = data

    await truncate(accessor, _path("/fs/big.bin"), 10)

    assert drive9.files["/root/big.bin"] == data[:10]
    assert drive9.count("PATCH", "/root") == 1


@pytest.mark.asyncio
async def test_a_large_file_grows_by_a_native_append_of_zeros(
    accessor, drive9
):
    drive9.part_size = 25_000
    drive9.files["/root/big.bin"] = b"x" * 60_000

    await truncate(accessor, _path("/fs/big.bin"), 70_000)

    assert drive9.files["/root/big.bin"] == b"x" * 60_000 + bytes(10_000)
    assert drive9.count("GET", "/root") == 0
    assert drive9.count("PUT", "/root") == 0


@pytest.mark.asyncio
async def test_an_inline_file_is_cut_by_a_rewrite(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello world"

    await truncate(accessor, _path("/fs/a.txt"), 5)

    assert drive9.files["/root/a.txt"] == b"hello"


@pytest.mark.asyncio
async def test_an_inline_file_grows_by_a_rewrite(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hi"

    await truncate(accessor, _path("/fs/a.txt"), 5)

    assert drive9.files["/root/a.txt"] == b"hi\0\0\0"


@pytest.mark.asyncio
async def test_an_inline_file_grown_past_the_inline_size_goes_multipart(
    accessor, drive9
):
    drive9.files["/root/a.txt"] = b"hi"

    await truncate(accessor, _path("/fs/a.txt"), 60_000)

    assert drive9.files["/root/a.txt"] == b"hi" + bytes(59_998)


@pytest.mark.asyncio
async def test_truncate_to_zero_reads_nothing(accessor, drive9):
    drive9.files["/root/big.bin"] = _big(60_000)

    await truncate(accessor, _path("/fs/big.bin"), 0)

    assert drive9.files["/root/big.bin"] == b""
    assert drive9.count("GET") == 0
    assert drive9.count("PATCH") == 0


@pytest.mark.asyncio
async def test_a_missing_file_is_made_of_zeros(accessor, drive9):
    await truncate(accessor, _path("/fs/new.bin"), 3)

    assert drive9.files["/root/new.bin"] == bytes(3)


@pytest.mark.asyncio
async def test_the_same_size_sends_no_write(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    await truncate(accessor, _path("/fs/a.txt"), 5)

    assert drive9.files["/root/a.txt"] == b"hello"
    assert drive9.count("PUT") == 0
    assert drive9.count("PATCH") == 0


@pytest.mark.asyncio
async def test_a_directory_is_refused(accessor, drive9):
    drive9.dirs.add("/root/d")

    with pytest.raises(IsADirectoryError):
        await truncate(accessor, _path("/fs/d"), 3)
    assert drive9.count("PUT") == 0


@pytest.mark.asyncio
async def test_no_create_is_refused_before_anything_is_sent(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    with pytest.raises(OperationNotSupportedError):
        await truncate(accessor, _path("/fs/a.txt"), 2, no_create=True)
    assert drive9.files["/root/a.txt"] == b"hello"
    assert drive9.requests == []


@pytest.mark.asyncio
async def test_a_negative_length_is_refused(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    with pytest.raises(OSError):
        await truncate(accessor, _path("/fs/a.txt"), -1)
    assert drive9.files["/root/a.txt"] == b"hello"


@pytest.mark.asyncio
async def test_a_failed_part_aborts_the_patch(accessor, drive9):
    data = _big(60_000)
    drive9.files["/root/big.bin"] = data
    drive9.fail_parts = True

    with pytest.raises(TiDBFilesystemApiError):
        await truncate(accessor, _path("/fs/big.bin"), 10)
    assert drive9.files["/root/big.bin"] == data
    assert drive9.uploads == {}
