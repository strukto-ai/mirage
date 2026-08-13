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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.core.dropbox.du import size
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec

_TREE = {
    "": [{
        ".tag": "folder",
        "id": "id:data",
        "name": "data",
        "path_display": "/data",
    }],
    "/data": [
        {
            ".tag": "folder",
            "id": "id:sub",
            "name": "sub",
            "path_display": "/data/sub",
        },
        {
            ".tag": "file",
            "id": "id:a",
            "name": "a.txt",
            "path_display": "/data/a.txt",
            "size": 27,
            "server_modified": "2026-04-01T00:00:00Z",
        },
    ],
    "/data/sub": [{
        ".tag": "file",
        "id": "id:b",
        "name": "b.txt",
        "path_display": "/data/sub/b.txt",
        "size": 12,
        "server_modified": "2026-04-01T00:00:00Z",
    }],
}


async def _fake_list(_tm, path):
    return _TREE[path]


@pytest.fixture
def accessor():
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_size_walks_directory_tree(accessor, index):
    with patch("mirage.core.dropbox.readdir.list_folder", new=_fake_list):
        total = await size(
            accessor,
            PathSpec(resource_path="data", virtual="/data", directory="/"),
            index)
    assert total == 39


@pytest.mark.asyncio
async def test_size_missing_path_is_zero(accessor, index):
    with patch("mirage.core.dropbox.readdir.list_folder", new=_fake_list):
        total = await size(
            accessor,
            PathSpec(resource_path="ghost", virtual="/ghost", directory="/"),
            index)
    assert total == 0
