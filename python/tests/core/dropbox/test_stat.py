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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.dropbox._client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.stat import stat
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import FileType, PathSpec


def make_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_mount_root_is_directory(index):
    out = await stat(make_accessor(),
                     PathSpec(resource_path="", virtual="/", directory="/"),
                     index)
    assert out.type == FileType.DIRECTORY
    assert out.name == "/"


@pytest.mark.asyncio
async def test_stat_populates_from_parent_listing(index):
    listing = [{
        ".tag": "file",
        "id": "id:1",
        "name": "note.txt",
        "path_display": "/note.txt",
        "size": 5,
        "server_modified": "2026-04-01T00:00:00Z",
    }]
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               return_value=listing):
        out = await stat(
            make_accessor(),
            PathSpec(resource_path="note.txt",
                     virtual="/note.txt",
                     directory="/"), index)
    assert out.size == 5
    assert out.type == FileType.TEXT
    assert out.extra["dropbox_id"] == "id:1"


@pytest.mark.asyncio
async def test_stat_missing_maps_api_error_to_enoent(index):
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("not found", 409)):
        with pytest.raises(FileNotFoundError):
            await stat(
                make_accessor(),
                PathSpec(resource_path="ghost/missing.txt",
                         virtual="/ghost/missing.txt",
                         directory="/ghost"), index)
