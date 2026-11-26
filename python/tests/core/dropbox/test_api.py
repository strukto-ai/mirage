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
from dataclasses import replace
from pathlib import Path

import pytest

from mirage.cache.types import MatchWrite
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.dropbox import api
from mirage.core.dropbox.api import (
    continue_folder,
    list_folder,
    move_path,
    search_files,
)
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.errors.types import StaleWriteError
from mirage.types import PathSpec
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

LIST_ROUTE = "/2/files/list_folder"
CONTINUE_ROUTE = "/2/files/list_folder/continue"
SEARCH_ROUTE = "/2/files/search_v2"
SEARCH_CONTINUE_ROUTE = "/2/files/search/continue_v2"
MOVE_ROUTE = "/2/files/move_v2"


def _tm(account) -> DropboxTokenManager:
    return account.accessor().token_manager


@pytest.mark.asyncio
async def test_list_folder_normalizes_root_to_empty_path(account):
    await account.run.record_requests()
    await list_folder(_tm(account), "/")
    sent = await account.run.bodies("POST", LIST_ROUTE)
    assert [body["path"] for body in sent] == [""]


@pytest.mark.asyncio
async def test_list_folder_pages_through_continue(account):
    await account.put("/docs/a", b"a")
    await account.put("/docs/b", b"b")
    await account.run.record_requests()
    out = await list_folder(_tm(account), "/docs", page_size=1)
    assert [e["name"] for e in out] == ["a", "b"]
    sent = await account.run.bodies("POST", CONTINUE_ROUTE)
    assert len(sent) == 1 and set(sent[0]) == {"cursor"}


@pytest.mark.asyncio
async def test_continue_folder_pages_through_continue(account):
    for name in ("a", "b", "c"):
        await account.put(f"/docs/{name}", b"x")
    first = await account.run.call(
        "POST", LIST_ROUTE, json={"path": "/docs", "limit": 1}
    )
    await account.run.record_requests()
    out, cursor = await continue_folder(_tm(account), first["cursor"])
    assert [e["name"] for e in out] == ["b", "c"]
    sent = await account.run.bodies("POST", CONTINUE_ROUTE)
    assert sent[0] == {"cursor": first["cursor"]}
    assert cursor not in ("", first["cursor"])


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
async def test_search_files_pages_dedups_and_skips_folders(account):
    # Dropbox may repeat a match on a later page; pages it never repeats
    # on the fake are answered here.
    await account.run.answer_next(
        "POST",
        SEARCH_ROUTE,
        200,
        {
            "matches": [
                _search_match("file", "/a.txt", "/A.txt"),
                _search_match("folder", "/dir", "/Dir"),
            ],
            "has_more": True,
            "cursor": "c1",
        },
    )
    await account.run.answer_next(
        "POST",
        SEARCH_CONTINUE_ROUTE,
        200,
        {
            "matches": [
                _search_match("file", "/a.txt", "/A.txt"),
                _search_match("file", "/b.txt", "/B.txt"),
            ],
            "has_more": False,
        },
    )
    await account.run.record_requests()
    out, truncated = await search_files(_tm(account), "needle", path="/docs")
    assert out == [("/a.txt", "/A.txt"), ("/b.txt", "/B.txt")]
    assert not truncated
    (first,) = await account.run.bodies("POST", SEARCH_ROUTE)
    assert first["query"] == "needle"
    assert first["options"] == {
        "max_results": api.SEARCH_PAGE,
        "file_status": "active",
        "filename_only": False,
        "path": "/docs",
    }
    assert await account.run.bodies("POST", SEARCH_CONTINUE_ROUTE) == [
        {"cursor": "c1"}
    ]


@pytest.mark.asyncio
async def test_search_files_account_root_omits_path(account):
    await account.run.record_requests()
    out, truncated = await search_files(_tm(account), "needle")
    assert out == []
    assert not truncated
    (first,) = await account.run.bodies("POST", SEARCH_ROUTE)
    assert "path" not in first["options"]


@pytest.mark.asyncio
async def test_search_files_flags_the_match_ceiling(account):
    # A first page that already holds 10,000 matches, with more to come:
    # the walk stops there.
    page = {
        "matches": [
            _search_match("file", f"/f{i}", f"/F{i}") for i in range(10_000)
        ],
        "has_more": True,
        "cursor": "c1",
    }
    await account.run.answer_next("POST", SEARCH_ROUTE, 200, page)
    await account.run.record_requests()
    out, truncated = await search_files(_tm(account), "needle")
    assert len(out) == 10_000
    assert truncated
    assert await account.run.bodies("POST", SEARCH_CONTINUE_ROUTE) == []


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
async def test_move_path_reads_only_an_object_as_the_moved_entry(
    account, reply, entry
):
    # Anything but an object names no kind, so the rename keeps its subtree
    # drop; the transport reads an empty body as None. Replies posted whole:
    # answer_next's None is the kit's own body.
    plan = {
        "method": "POST",
        "route": MOVE_ROUTE,
        "status": 200,
        "body": reply,
    }
    await account.run.call("POST", "/_kit/faults", json={"plans": [plan]})
    assert await move_path(_tm(account), "/a", "/b") == entry


@pytest.mark.asyncio
async def test_move_path_answers_the_moved_entry(account):
    await account.put("/a", b"a")
    moved = await move_path(_tm(account), "/a", "/b")
    assert moved == await account.metadata("/b")


async def _refuse(
    exc: DropboxApiError, sent: str | None
) -> tuple[KeptVersions, StaleWriteError | None]:
    store = KeptVersions("dropbox")
    prev = bind_caller(
        replace(current_caller(), write_context=store.context())
    )
    try:
        path = PathSpec(virtual="/dbx/f", directory="/dbx/", vfs_path="/f")
        got = await api.refused(path, exc, MatchWrite("s1"), sent)
    finally:
        reset_caller(prev)
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
    outcome = {"lost": ["s1"], "gone": ["s1"]}.get(case["outcome"])
    if sent is None or outcome is None:
        assert got is None and store.kept == []
    else:
        assert isinstance(got, StaleWriteError) and store.kept == outcome
