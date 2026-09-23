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

from unittest.mock import patch

import pytest

from mirage.core.box.client import BoxApiError
from mirage.core.box.du.walk import walk
from mirage.types import PathSpec

_TREE = {
    "0": [
        {
            "id": "100",
            "name": "data",
            "type": "folder",
            "modified_at": "2026-04-01T00:00:00+00:00",
        },
    ],
    "100": [
        {
            "id": "101",
            "name": "sub",
            "type": "folder",
            "modified_at": "2026-04-01T00:00:00+00:00",
        },
        {
            "id": "200",
            "name": "a.txt",
            "type": "file",
            "size": 27,
            "modified_at": "2026-04-01T00:00:00+00:00",
        },
    ],
    "101": [
        {
            "id": "201",
            "name": "b.txt",
            "type": "file",
            "size": 12,
            "modified_at": "2026-04-01T00:00:00+00:00",
        },
    ],
}

_DATA = PathSpec(vfs_path="data", virtual="/data", directory="/")


async def _fake_list(_tm, folder_id, limit=1000):
    return _TREE[folder_id]


def _lister(fail_on: str, status: int):

    async def _fake_list(_tm, folder_id, limit=1000):
        if folder_id == fail_on:
            raise BoxApiError(
                f"Box GET /folders/{folder_id}/items -> {status} boom", status)
        return _TREE[folder_id]

    return _fake_list


@pytest.mark.asyncio
async def test_walk_sums_every_file_in_the_subtree(accessor, index):
    with patch("mirage.core.box.readdir.list_folder_items", new=_fake_list):
        results: list[tuple[str, int]] = []
        total = await walk(accessor, _DATA, index, results)
    assert total == 39
    assert sorted(results) == [("/data/a.txt", 27), ("/data/sub/b.txt", 12)]


@pytest.mark.asyncio
async def test_walk_counts_a_folder_deleted_mid_walk_as_zero(accessor, index):
    with patch("mirage.core.box.readdir.list_folder_items",
               new=_lister("101", 404)):
        total = await walk(accessor, _DATA, index, None)
    assert total == 27


@pytest.mark.asyncio
async def test_walk_propagates_a_throttled_listing(accessor, index):
    with patch("mirage.core.box.readdir.list_folder_items",
               new=_lister("101", 429)):
        with pytest.raises(BoxApiError) as caught:
            await walk(accessor, _DATA, index, None)
    assert caught.value.status == 429


@pytest.mark.asyncio
async def test_walk_propagates_a_server_error_on_the_operand(accessor, index):
    with patch("mirage.core.box.readdir.list_folder_items",
               new=_lister("100", 500)):
        with pytest.raises(BoxApiError) as caught:
            await walk(accessor, _DATA, index, None)
    assert caught.value.status == 500
