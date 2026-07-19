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
from mirage.core.dropbox._client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.copy import copy
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_copy_maps_paths_under_mount_root():
    with patch("mirage.core.dropbox.copy.copy_path",
               new_callable=AsyncMock) as copied:
        await copy(make_accessor("/Team"), PathSpec.from_str_path("/a.txt"),
                   PathSpec.from_str_path("/b.txt"))
    assert copied.await_args.args[1:] == ("/Team/a.txt", "/Team/b.txt")


@pytest.mark.asyncio
async def test_copy_replaces_existing_destination_file():
    conflict = DropboxApiError("conflict", 409, "to/conflict/file/...")
    with patch("mirage.core.dropbox.copy.copy_path",
               new_callable=AsyncMock,
               side_effect=[conflict, None]) as copied:
        with patch("mirage.core.dropbox.copy.get_metadata",
                   new_callable=AsyncMock,
                   return_value={
                       ".tag": "file",
                       "name": "b.txt"
                   }):
            with patch("mirage.core.dropbox.copy.delete_path",
                       new_callable=AsyncMock) as deleted:
                await copy(make_accessor(), PathSpec.from_str_path("/a.txt"),
                           PathSpec.from_str_path("/b.txt"))
    assert deleted.await_args.args[1] == "/b.txt"
    assert copied.await_count == 2
