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
from mirage.core.dropbox.exists import exists
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec


def make_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_mount_root_exists_without_api_call():
    with patch("mirage.core.dropbox.exists.get_metadata",
               new_callable=AsyncMock) as meta:
        assert await exists(make_accessor(), PathSpec.from_str_path("/"))
    meta.assert_not_awaited()


@pytest.mark.asyncio
async def test_409_maps_to_false():
    with patch("mirage.core.dropbox.exists.get_metadata",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("nf", 409, "path/not_found/...")):
        assert not await exists(make_accessor(),
                                PathSpec.from_str_path("/ghost"))


@pytest.mark.asyncio
async def test_found_maps_to_true():
    with patch("mirage.core.dropbox.exists.get_metadata",
               new_callable=AsyncMock,
               return_value={
                   ".tag": "file",
                   "name": "a.txt"
               }):
        assert await exists(make_accessor(), PathSpec.from_str_path("/a.txt"))
