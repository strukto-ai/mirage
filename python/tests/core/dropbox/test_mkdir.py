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
from mirage.core.dropbox.mkdir import mkdir
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec

NOT_FOUND = DropboxApiError("nf", 409, "path/not_found/...")


def make_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_mkdir_creates_when_parent_exists():

    async def fake_meta(tm, path):
        if path == "/docs":
            raise NOT_FOUND
        return {".tag": "folder", "name": path.rsplit("/", 1)[1]}

    with patch("mirage.core.dropbox.mkdir.get_metadata",
               side_effect=fake_meta):
        with patch("mirage.core.dropbox.mkdir.create_folder",
                   new_callable=AsyncMock) as created:
            await mkdir(make_accessor(), PathSpec.from_str_path("/docs"))
    assert created.await_args.args[1] == "/docs"


@pytest.mark.asyncio
async def test_mkdir_existing_raises_eexist():
    with patch("mirage.core.dropbox.mkdir.get_metadata",
               new_callable=AsyncMock,
               return_value={
                   ".tag": "folder",
                   "name": "docs"
               }):
        with pytest.raises(FileExistsError):
            await mkdir(make_accessor(), PathSpec.from_str_path("/docs"))


@pytest.mark.asyncio
async def test_mkdir_parents_is_idempotent_for_existing_dir():
    with patch("mirage.core.dropbox.mkdir.get_metadata",
               new_callable=AsyncMock,
               return_value={
                   ".tag": "folder",
                   "name": "docs"
               }):
        with patch("mirage.core.dropbox.mkdir.create_folder",
                   new_callable=AsyncMock) as created:
            await mkdir(make_accessor(),
                        PathSpec.from_str_path("/docs"),
                        parents=True)
    created.assert_not_awaited()


@pytest.mark.asyncio
async def test_mkdir_missing_parent_raises_enoent():
    with patch("mirage.core.dropbox.mkdir.get_metadata",
               new_callable=AsyncMock,
               side_effect=NOT_FOUND):
        with patch("mirage.core.dropbox.mkdir.create_folder",
                   new_callable=AsyncMock) as created:
            with pytest.raises(FileNotFoundError):
                await mkdir(make_accessor(), PathSpec.from_str_path("/a/b"))
    created.assert_not_awaited()
