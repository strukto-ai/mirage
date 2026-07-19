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
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.core.dropbox.read import read
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


FILE_LISTING = [{
    ".tag": "file",
    "id": "id:1",
    "name": "note.txt",
    "path_display": "/note.txt",
    "size": 5,
}]


@pytest.mark.asyncio
async def test_read_strips_mount_prefix(index):
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               return_value=FILE_LISTING):
        with patch("mirage.core.dropbox.read.dropbox_download",
                   new_callable=AsyncMock,
                   return_value=b"hi!") as download:
            data = await read(
                make_accessor(),
                PathSpec(virtual="/dropbox/note.txt",
                         directory="/dropbox",
                         resource_path=mount_key("/dropbox/note.txt",
                                                 "/dropbox")), index)
    assert data == b"hi!"
    assert download.await_args.args[1] == "/note.txt"


@pytest.mark.asyncio
async def test_read_downloads_through_subfolder_root(index):
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               return_value=FILE_LISTING):
        with patch("mirage.core.dropbox.read.dropbox_download",
                   new_callable=AsyncMock,
                   return_value=b"hi") as download:
            data = await read(
                make_accessor("Team/data"),
                PathSpec(virtual="/dropbox/note.txt",
                         directory="/dropbox",
                         resource_path=mount_key("/dropbox/note.txt",
                                                 "/dropbox")), index)
    assert data == b"hi"
    assert download.await_args.args[1] == "/Team/data/note.txt"


@pytest.mark.asyncio
async def test_read_folder_raises_isadirectory(index):
    listing = [{
        ".tag": "folder",
        "id": "id:f",
        "name": "docs",
        "path_display": "/docs",
    }]
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               return_value=listing):
        with pytest.raises(IsADirectoryError):
            await read(
                make_accessor(),
                PathSpec(resource_path="docs",
                         virtual="/docs",
                         directory="/docs"), index)


@pytest.mark.asyncio
async def test_read_missing_raises_enoent(index):
    with patch("mirage.core.dropbox.readdir.list_folder",
               new_callable=AsyncMock,
               return_value=[]):
        with pytest.raises(FileNotFoundError):
            await read(
                make_accessor(),
                PathSpec(resource_path="missing.txt",
                         virtual="/missing.txt",
                         directory="/"), index)
