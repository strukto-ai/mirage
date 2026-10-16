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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.hf_hub.checksum import checksum
from mirage.core.hf_hub.tree import parse_entry, row_of
from mirage.types import FileStat
from tests.core.hf_hub.conftest import dir_row, file_row, ps

SHA = "a" * 64
LFS = {"oid": SHA, "size": 7, "pointerSize": 135}


def _point(rows):
    return patch(
        "mirage.core.hf_hub.tree.hub_post", AsyncMock(return_value=rows)
    )


def _row(item: dict) -> FileStat:
    return row_of(parse_entry(item), item["path"].rsplit("/", 1)[-1])


@pytest.mark.asyncio
async def test_an_lfs_file_answers_its_sha256_from_one_row(accessor):
    listed = _row(file_row("w.bin", 7, lfs=LFS))
    with _point([file_row("w.bin", 7, lfs=LFS)]) as post:
        assert await checksum(accessor, ps("w.bin"), "sha256", listed) == SHA
    assert post.await_count == 1
    assert post.await_args.args[2] == {"paths": ["w.bin"], "expand": False}


@pytest.mark.asyncio
async def test_the_row_is_asked_again_since_the_listing_can_be_older(
    accessor,
):
    listed = _row(file_row("w.bin", 7, lfs={"oid": "b" * 64}))
    with _point([file_row("w.bin", 7, lfs=LFS)]):
        assert await checksum(accessor, ps("w.bin"), "sha256", listed) == SHA


@pytest.mark.asyncio
async def test_a_plain_blob_is_read_without_a_request(accessor):
    listed = _row(file_row("a.txt", 7))
    with _point([file_row("a.txt", 7)]) as post:
        assert await checksum(accessor, ps("a.txt"), "sha256", listed) is None
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_row_no_longer_lfs_is_read(accessor):
    listed = _row(file_row("w.bin", 7, lfs=LFS))
    with _point([file_row("w.bin", 7)]):
        assert await checksum(accessor, ps("w.bin"), "sha256", listed) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("algorithm", ["md5", "sha1", "sha512"])
async def test_another_algorithm_is_read_without_a_request(
    accessor, algorithm
):
    listed = _row(file_row("w.bin", 7, lfs=LFS))
    with _point([]) as post:
        assert await checksum(accessor, ps("w.bin"), algorithm, listed) is None
    post.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_row_gone_since_the_listing_is_read(accessor):
    listed = _row(file_row("w.bin", 7, lfs=LFS))
    with _point([]):
        assert await checksum(accessor, ps("w.bin"), "sha256", listed) is None


@pytest.mark.asyncio
async def test_a_missing_path_and_a_directory_raise_as_the_read(accessor):
    with _point([]) as post:
        with pytest.raises(FileNotFoundError):
            await checksum(accessor, ps("nope"), "sha256", None)
        with pytest.raises(IsADirectoryError):
            await checksum(accessor, ps("d"), "sha256", _row(dir_row("d")))
    post.assert_not_awaited()
