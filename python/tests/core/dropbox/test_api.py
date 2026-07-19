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

from mirage.core.dropbox import api
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.core.dropbox.api import list_folder, search_files
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


def _search_match(tag: str, lower: str, display: str) -> dict:
    return {
        "match_type": {
            ".tag": "filename"
        },
        "metadata": {
            ".tag": "metadata",
            "metadata": {
                ".tag": tag,
                "path_lower": lower,
                "path_display": display,
            },
        },
    }


@pytest.mark.asyncio
async def test_search_files_pages_dedups_and_skips_folders():
    pages = [
        {
            "matches": [
                _search_match("file", "/a.txt", "/A.txt"),
                _search_match("folder", "/dir", "/Dir"),
            ],
            "has_more":
            True,
            "cursor":
            "c1",
        },
        {
            "matches": [
                _search_match("file", "/a.txt", "/A.txt"),
                _search_match("file", "/b.txt", "/B.txt"),
            ],
            "has_more":
            False,
        },
    ]
    with patch("mirage.core.dropbox.api.dropbox_rpc",
               new_callable=AsyncMock,
               side_effect=pages) as rpc:
        out, truncated = await search_files(TM, "needle", path="/docs")
    assert out == [("/a.txt", "/A.txt"), ("/b.txt", "/B.txt")]
    assert not truncated
    first_call = rpc.await_args_list[0]
    assert first_call.args[1] == "/files/search_v2"
    assert first_call.args[2]["query"] == "needle"
    assert first_call.args[2]["options"] == {
        "max_results": api.SEARCH_PAGE,
        "file_status": "active",
        "filename_only": False,
        "path": "/docs",
    }
    continue_call = rpc.await_args_list[1]
    assert continue_call.args[1] == "/files/search/continue_v2"
    assert continue_call.args[2] == {"cursor": "c1"}


@pytest.mark.asyncio
async def test_search_files_account_root_omits_path():
    with patch("mirage.core.dropbox.api.dropbox_rpc",
               new_callable=AsyncMock,
               return_value={
                   "matches": [],
                   "has_more": False
               }) as rpc:
        out, truncated = await search_files(TM, "needle")
    assert out == []
    assert not truncated
    assert "path" not in rpc.await_args.args[2]["options"]


@pytest.mark.asyncio
async def test_search_files_flags_the_match_ceiling(monkeypatch):
    monkeypatch.setattr(api, "MAX_SEARCH_MATCHES", 1)
    page = {
        "matches": [_search_match("file", "/a.txt", "/A.txt")],
        "has_more": True,
        "cursor": "c1",
    }
    with patch("mirage.core.dropbox.api.dropbox_rpc",
               new_callable=AsyncMock,
               return_value=page) as rpc:
        out, truncated = await search_files(TM, "needle")
    assert out == [("/a.txt", "/A.txt")]
    assert truncated
    assert rpc.await_count == 1
