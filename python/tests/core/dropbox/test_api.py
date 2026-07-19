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

from mirage.core.dropbox._client import DropboxTokenManager
from mirage.core.dropbox.api import list_folder
from mirage.resource.dropbox.config import DropboxConfig

TM = DropboxTokenManager(
    DropboxConfig(client_id="c", client_secret="s", refresh_token="r"))


@pytest.mark.asyncio
async def test_list_folder_normalizes_root_to_empty_path():
    with patch("mirage.core.dropbox.api.dropbox_rpc",
               new_callable=AsyncMock,
               return_value={
                   "entries": [],
                   "cursor": "c0",
                   "has_more": False
               }) as rpc:
        await list_folder(TM, "/")
    assert rpc.await_args.args[2]["path"] == ""


@pytest.mark.asyncio
async def test_list_folder_pages_through_continue():
    pages = [
        {
            "entries": [{
                "name": "a"
            }],
            "cursor": "c1",
            "has_more": True
        },
        {
            "entries": [{
                "name": "b"
            }],
            "cursor": "c2",
            "has_more": False
        },
    ]
    with patch("mirage.core.dropbox.api.dropbox_rpc",
               new_callable=AsyncMock,
               side_effect=pages) as rpc:
        out = await list_folder(TM, "/docs")
    assert [e["name"] for e in out] == ["a", "b"]
    continue_call = rpc.await_args_list[1]
    assert continue_call.args[1] == "/files/list_folder/continue"
    assert continue_call.args[2] == {"cursor": "c1"}
