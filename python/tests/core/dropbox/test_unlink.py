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
from mirage.core.dropbox.unlink import unlink
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec


def make_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_unlink_deletes_file():
    with patch("mirage.core.dropbox.unlink.get_metadata",
               new_callable=AsyncMock,
               return_value={
                   ".tag": "file",
                   "name": "a.txt"
               }):
        with patch("mirage.core.dropbox.unlink.delete_path",
                   new_callable=AsyncMock) as deleted:
            await unlink(make_accessor(), PathSpec.from_str_path("/a.txt"))
    assert deleted.await_args.args[1] == "/a.txt"


@pytest.mark.asyncio
async def test_unlink_folder_raises_eisdir():
    with patch("mirage.core.dropbox.unlink.get_metadata",
               new_callable=AsyncMock,
               return_value={
                   ".tag": "folder",
                   "name": "docs"
               }):
        with patch("mirage.core.dropbox.unlink.delete_path",
                   new_callable=AsyncMock) as deleted:
            with pytest.raises(IsADirectoryError):
                await unlink(make_accessor(), PathSpec.from_str_path("/docs"))
    deleted.assert_not_awaited()


@pytest.mark.asyncio
async def test_unlink_missing_raises_enoent():
    with patch("mirage.core.dropbox.unlink.get_metadata",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("nf", 409, "path/not_found/...")):
        with pytest.raises(FileNotFoundError):
            await unlink(make_accessor(), PathSpec.from_str_path("/ghost"))
