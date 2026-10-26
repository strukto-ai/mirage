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

from mirage.core.tidb_filesystem import client
from mirage.core.tidb_filesystem.client import (
    append_to,
    download,
    move,
    remove_tree,
    stat_entries,
    upload,
)
from mirage.core.tidb_filesystem.constants import MAX_UPLOAD_WORKERS
from mirage.core.tidb_filesystem.errors import TiDBFilesystemApiError
from mirage.io.spool import ByteSpool
from mirage.utils.ranges import ByteWindow


@pytest.mark.asyncio
async def test_small_upload_is_one_put(accessor, drive9):
    await upload(accessor, "/root/a.txt", b"hello")

    assert drive9.files["/root/a.txt"] == b"hello"
    assert drive9.requests == [("PUT", "/root/a.txt?")]


@pytest.mark.asyncio
async def test_large_upload_goes_up_in_parts_without_the_token(
    accessor, drive9
):
    drive9.part_size = 20_000
    data = bytes(range(256)) * 300

    await upload(accessor, "/root/big.bin", data)

    assert drive9.files["/root/big.bin"] == data
    assert drive9.count("PUT", "/s3/upload") == 4
    assert drive9.leaked == []
    assert drive9.uploads == {}


@pytest.mark.asyncio
async def test_failed_part_aborts_the_upload(accessor, drive9, monkeypatch):
    drive9.part_size = 20_000
    drive9.fail_parts = True
    monkeypatch.setattr(client, "PRESIGN_BATCH", 1)

    with pytest.raises(TiDBFilesystemApiError):
        await upload(accessor, "/root/big.bin", b"x" * 60_000)

    assert drive9.count("POST", "/v2/uploads/abort") == 1
    assert "/root/big.bin" not in drive9.files


@pytest.mark.asyncio
async def test_presign_asks_in_batches(accessor, drive9, monkeypatch):
    drive9.part_size = 10_000
    monkeypatch.setattr(client, "PRESIGN_BATCH", 2)

    await upload(accessor, "/root/big.bin", b"y" * 55_000)

    assert drive9.count("POST", "/v2/uploads/presign-batch") == 3
    assert drive9.files["/root/big.bin"] == b"y" * 55_000


@pytest.mark.asyncio
async def test_parts_go_up_a_few_at_a_time(accessor, drive9):
    drive9.part_size = 10_000
    drive9.part_delay = 0.02
    data = bytes(range(256)) * 400

    await upload(accessor, "/root/big.bin", data)

    assert drive9.peak == MAX_UPLOAD_WORKERS
    assert drive9.files["/root/big.bin"] == data


@pytest.mark.asyncio
async def test_a_spooled_body_goes_up_from_its_spool(accessor, drive9):
    drive9.part_size = 20_000
    data = bytes(range(256)) * 300
    async with ByteSpool(memory_limit=1_000) as spool:
        await spool.append(data)

        await upload(accessor, "/root/big.bin", spool)

    assert drive9.files["/root/big.bin"] == data


@pytest.mark.asyncio
async def test_append_sends_only_the_last_part_and_the_new_bytes(
    accessor, drive9
):
    drive9.part_size = 25_000
    head = bytes(range(256)) * 235
    drive9.files["/root/big.bin"] = head
    tail = b"tail" * 7_500

    assert await append_to(accessor, "/root/big.bin", tail) is True

    assert drive9.files["/root/big.bin"] == head + tail
    assert drive9.count("GET", "/s3/objects") == 1
    assert drive9.count("PUT", "/s3/upload") == 2
    assert drive9.count("PUT", "/root") == 0
    assert drive9.leaked == []
    assert drive9.uploads == {}


@pytest.mark.asyncio
async def test_append_to_an_inline_file_sends_nothing(accessor, drive9):
    drive9.files["/root/a.txt"] = b"hello"

    assert await append_to(accessor, "/root/a.txt", b"!") is False

    assert drive9.files["/root/a.txt"] == b"hello"
    assert drive9.uploads == {}


@pytest.mark.asyncio
async def test_append_to_a_missing_file_sends_nothing(accessor, drive9):
    assert await append_to(accessor, "/root/nope", b"!") is False

    assert "/root/nope" not in drive9.files


@pytest.mark.asyncio
async def test_failed_append_part_aborts_the_upload(accessor, drive9):
    drive9.part_size = 25_000
    drive9.files["/root/big.bin"] = b"x" * 60_000
    drive9.fail_parts = True

    with pytest.raises(TiDBFilesystemApiError):
        await append_to(accessor, "/root/big.bin", b"y" * 100)

    assert drive9.count("DELETE", "/v1/uploads/") == 1
    assert drive9.files["/root/big.bin"] == b"x" * 60_000
    assert drive9.uploads == {}


@pytest.mark.asyncio
async def test_append_plan_without_the_old_bytes_is_refused(accessor, drive9):
    drive9.part_size = 25_000
    drive9.files["/root/big.bin"] = b"x" * 60_000
    drive9.drop_read_urls = True

    with pytest.raises(TiDBFilesystemApiError, match="does not match"):
        await append_to(accessor, "/root/big.bin", b"y" * 100)

    assert drive9.count("PUT", "/s3/upload") == 0
    assert drive9.files["/root/big.bin"] == b"x" * 60_000
    assert drive9.uploads == {}


@pytest.mark.asyncio
async def test_large_read_follows_the_redirect_without_the_token(
    accessor, drive9
):
    data = bytes(range(256)) * 400
    drive9.files["/root/big.bin"] = data

    whole = await download(accessor, "/root/big.bin")
    part = await download(
        accessor, "/root/big.bin", window=ByteWindow(100, 50)
    )

    assert whole == data
    assert part == data[100:150]
    assert drive9.leaked == []


@pytest.mark.asyncio
async def test_inline_read_is_trimmed_to_the_window(accessor, drive9):
    drive9.files["/root/a.txt"] = b"0123456789"

    assert await download(
        accessor, "/root/a.txt", window=ByteWindow(2, 3)
    ) == (b"234")


@pytest.mark.asyncio
async def test_batch_stat_splits_at_the_limit(accessor, drive9, monkeypatch):
    monkeypatch.setattr(client, "BATCH_STAT_LIMIT", 2)
    drive9.files["/root/a"] = b"abc"
    drive9.dirs.add("/root/d")

    found = await stat_entries(
        accessor, ["/root/a", "/root/d", "/root/missing"]
    )

    assert [(e.name, e.is_dir, e.size) if e else None for e in found] == [
        ("a", False, 3),
        ("d", True, 0),
        None,
    ]
    assert drive9.count("POST", "/v1/fs:batch-stat") == 2


@pytest.mark.asyncio
async def test_tree_delete_resends_after_busy(accessor, drive9):
    drive9.dirs.update({"/root/d", "/root/d/e"})
    drive9.files["/root/d/e/f"] = b"x"
    drive9.busy_deletes = 2

    await remove_tree(accessor, "/root/d")

    assert drive9.count("DELETE") == 3
    assert drive9.dirs == {"/root"}


@pytest.mark.asyncio
async def test_move_carries_a_non_latin_source(accessor, drive9):
    drive9.files["/root/你好 x.txt"] = b"hi"

    await move(accessor, "/root/你好 x.txt", "/root/moved.txt")

    assert drive9.files == {"/root/moved.txt": b"hi"}
