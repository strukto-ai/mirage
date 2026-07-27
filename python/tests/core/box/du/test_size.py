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

from mirage.core.box.du import size
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


async def _fake_list(_tm, folder_id, limit=1000):
    return _TREE[folder_id]


@pytest.mark.asyncio
async def test_size_walks_directory_tree(accessor, index):
    with patch("mirage.core.box.readdir.list_folder_items", new=_fake_list):
        total = await size(
            accessor,
            PathSpec(resource_path="data", virtual="/data", directory="/"),
            index)
    assert total == 39


@pytest.mark.asyncio
async def test_size_missing_path_is_zero(accessor, index):
    with patch("mirage.core.box.readdir.list_folder_items", new=_fake_list), \
         patch("mirage.core.box.resolve.list_folder_items", new=_fake_list):
        total = await size(
            accessor,
            PathSpec(resource_path="ghost", virtual="/ghost", directory="/"),
            index)
    assert total == 0
