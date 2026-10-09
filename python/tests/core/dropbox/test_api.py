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

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.context import push_write_context
from mirage.cache.types import WriteCondition
from mirage.core.dropbox import api
from mirage.core.dropbox.api import (
    continue_folder,
    list_folder,
    list_folder_state,
    move_path,
    search_files,
)
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.errors.types import StaleWriteError
from mirage.types import PathSpec
from mirage.vfs.dropbox.config import DropboxConfig
from tests.fixtures.write_context import KeptVersions

_LOST = json.loads(
    (
        Path(__file__).parents[4]
        / "integ"
        / "fixtures"
        / "write"
        / "drive_lost_codes.json"
    ).read_text()
)

TM = DropboxTokenManager(
    DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
)


@pytest.mark.asyncio
async def test_list_folder_normalizes_root_to_empty_path():
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        return_value={"entries": [], "cursor": "c0", "has_more": False},
    ) as rpc:
        await list_folder(TM, "/")
    assert rpc.await_args.args[2]["path"] == ""


@pytest.mark.asyncio
async def test_list_folder_pages_through_continue():
    pages = [
        {"entries": [{"name": "a"}], "cursor": "c1", "has_more": True},
        {"entries": [{"name": "b"}], "cursor": "c2", "has_more": False},
    ]
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        side_effect=pages,
    ) as rpc:
        out = await list_folder(TM, "/docs")
    assert [e["name"] for e in out] == ["a", "b"]
    continue_call = rpc.await_args_list[1]
    assert continue_call.args[1] == "/files/list_folder/continue"
    assert continue_call.args[2] == {"cursor": "c1"}


@pytest.mark.asyncio
async def test_list_folder_state_keeps_the_last_cursor():
    pages = [
        {"entries": [{"name": "a"}], "cursor": "c1", "has_more": True},
        {"entries": [{"name": "b"}], "cursor": "c2", "has_more": False},
    ]
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        side_effect=pages,
    ):
        out, cursor = await list_folder_state(TM, "/docs")
    assert [e["name"] for e in out] == ["a", "b"]
    assert cursor == "c2"


@pytest.mark.asyncio
async def test_continue_folder_pages_through_continue():
    pages = [
        {"entries": [{"name": "a"}], "cursor": "c1", "has_more": True},
        {"entries": [{"name": "b"}], "cursor": "c2", "has_more": False},
    ]
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        side_effect=pages,
    ) as rpc:
        out, cursor = await continue_folder(TM, "c0")
    assert [e["name"] for e in out] == ["a", "b"]
    assert cursor == "c2"
    assert rpc.await_args_list[0].args[1] == "/files/list_folder/continue"
    assert rpc.await_args_list[0].args[2] == {"cursor": "c0"}


def _search_match(tag: str, lower: str, display: str) -> dict:
    return {
        "match_type": {".tag": "filename"},
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
            "has_more": True,
            "cursor": "c1",
        },
        {
            "matches": [
                _search_match("file", "/a.txt", "/A.txt"),
                _search_match("file", "/b.txt", "/B.txt"),
            ],
            "has_more": False,
        },
    ]
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        side_effect=pages,
    ) as rpc:
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
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        return_value={"matches": [], "has_more": False},
    ) as rpc:
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
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        return_value=page,
    ) as rpc:
        out, truncated = await search_files(TM, "needle")
    assert out == [("/a.txt", "/A.txt")]
    assert truncated
    assert rpc.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reply", "entry"),
    [
        (
            {"metadata": {".tag": "file", "name": "b"}},
            {".tag": "file", "name": "b"},
        ),
        (None, {}),
        ({}, {}),
        ({"metadata": None}, {}),
        ({"metadata": "b"}, {}),
        ({"metadata": []}, {}),
        (["b"], {}),
    ],
    ids=[
        "entry",
        "empty",
        "no-metadata",
        "null",
        "string",
        "array",
        "list-reply",
    ],
)
async def test_move_path_reads_only_an_object_as_the_moved_entry(reply, entry):
    # Anything but an object names no kind, so the rename keeps its subtree
    # drop; the transport reads an empty body as None.
    with patch(
        "mirage.core.dropbox.api.dropbox_rpc",
        new_callable=AsyncMock,
        return_value=reply,
    ):
        assert await move_path(TM, "/a", "/b") == entry


async def _refuse(
    exc: DropboxApiError, sent: str | None
) -> tuple[KeptVersions, StaleWriteError | None]:
    store = KeptVersions("dropbox")
    prev = push_write_context(store.context())
    try:
        path = PathSpec(virtual="/dbx/f", directory="/dbx/", vfs_path="/f")
        got = await api.refused(path, exc, WriteCondition("s1"), sent)
    finally:
        push_write_context(prev)
    return store, got


@pytest.mark.asyncio
@pytest.mark.parametrize("sent", ["e1", None], ids=["sent", "plain"])
@pytest.mark.parametrize(
    "case", _LOST["dropbox"], ids=[c["name"] for c in _LOST["dropbox"]]
)
async def test_refused_reads_dropbox_answers_like_the_shared_table(case, sent):
    store, got = await _refuse(
        DropboxApiError("x", 409, case["summary"]), sent
    )
    outcome = {"lost": ["s1"], "gone": []}.get(case["outcome"])
    if sent is None or outcome is None:
        assert got is None and store.kept == []
    else:
        assert isinstance(got, StaleWriteError) and store.kept == outcome
