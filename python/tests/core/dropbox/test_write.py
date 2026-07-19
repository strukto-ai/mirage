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
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.core.dropbox.create import create
from mirage.core.dropbox.write import write_bytes
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_write_uploads_through_subfolder_root():
    with patch("mirage.core.dropbox.write.dropbox_upload",
               new_callable=AsyncMock) as upload:
        await write_bytes(make_accessor("/Team/data"),
                          PathSpec.from_str_path("/note.txt"), b"hi")
    assert upload.await_args.args[1] == "/Team/data/note.txt"
    assert upload.await_args.args[2] == b"hi"


@pytest.mark.asyncio
async def test_create_uploads_empty_bytes():
    with patch("mirage.core.dropbox.write.dropbox_upload",
               new_callable=AsyncMock) as upload:
        await create(make_accessor(), PathSpec.from_str_path("/new.txt"))
    assert upload.await_args.args[1] == "/new.txt"
    assert upload.await_args.args[2] == b""
