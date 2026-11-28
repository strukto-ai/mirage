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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.types import MatchWrite
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.box.api import (
    SEARCH_FIELDS,
    absent_on_404,
    create_folder,
    events_now,
    events_since,
    list_folder_items,
    realtime_server,
    refused,
    search_content,
    upload_file_version,
    upload_new_file,
)
from mirage.core.box.client import BoxApiError, BoxTokenManager
from mirage.errors.types import StaleWriteError
from mirage.io.spool import ByteSpool
from mirage.types import PathSpec
from mirage.vfs.box.config import BoxConfig
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


ITEMS_ROUTE = "/2.0/folders/:folder_id/items"
SEARCH_ROUTE = "/2.0/search"
EVENTS_ROUTE = "/2.0/events"
# Box spells a stream position as a JSON number near 1.15e18, past the 2**53
# a JavaScript number holds exactly; the kit parses a plan in JavaScript, so
# an answer carrying one is sent as written.
POSITION = "1152922976252290886"


@pytest.fixture
def tm():
    return BoxTokenManager(BoxConfig(access_token="tok"))


def _tm(account) -> BoxTokenManager:
    return account.accessor().token_manager


@pytest.mark.asyncio
async def test_list_folder_items_follows_offset_pagination(account):
    for name in ("a", "b", "c"):
        await account.put(name, b"x")
    await account.run.record_requests()
    items = await list_folder_items(_tm(account), "0", page_size=2)
    assert [it["name"] for it in items] == ["a", "b", "c"]
    pages = await account.run.params("GET", ITEMS_ROUTE)
    assert [page.get("offset") for page in pages] == ["0", "2"]


@pytest.mark.asyncio
async def test_list_folder_items_counts_no_web_link_toward_a_limit(account):
    # Box lists the two web links first, by name; a limit counted them
    # would stop after that page.
    await account.web_link("a")
    await account.web_link("b")
    await account.put("c", b"x")
    await account.put("d", b"x")
    await account.run.record_requests()
    items = await list_folder_items(_tm(account), "0", page_size=2, limit=2)
    assert [it["name"] for it in items] == ["a", "b", "c", "d"]
    assert len(await account.run.params("GET", ITEMS_ROUTE)) == 2


@pytest.mark.asyncio
async def test_list_folder_items_stops_on_empty_page(account):
    await account.run.answer_next(
        "GET", ITEMS_ROUTE, 200, {"total_count": 5, "entries": []}
    )
    await account.run.record_requests()
    assert await list_folder_items(_tm(account), "0") == []
    assert len(await account.run.params("GET", ITEMS_ROUTE)) == 1


@pytest.mark.asyncio
async def test_search_content_scopes_and_matches_content(account):
    # Only a file under the folder, found by its content: the name match
    # outside the folder and the folder named like the query are not.
    folder = await account.mkdir("scope")
    hit = await account.put("hit", b"one needle here", folder)
    await account.put("needle.txt", b"x")
    await account.mkdir("needle", folder)
    await account.run.record_requests()
    items, truncated = await search_content(_tm(account), "needle", folder)
    assert [it["id"] for it in items] == [hit]
    assert truncated is False
    (sent,) = await account.run.params("GET", SEARCH_ROUTE)
    assert sent["ancestor_folder_ids"] == folder
    assert sent["content_types"] == "name,file_content"
    assert sent["type"] == "file"
    assert sent["fields"] == SEARCH_FIELDS


@pytest.mark.asyncio
async def test_search_content_flags_truncation_at_ceiling(account):
    # More hits than the fake would hold: Box's own pages of 200.
    page = {
        "total_count": 20_000,
        "entries": [
            {"id": str(i), "name": "f", "type": "file"} for i in range(200)
        ],
    }
    await account.run.answer_next("GET", SEARCH_ROUTE, 200, page, times=60)
    items, truncated = await search_content(_tm(account), "q", "0")
    assert truncated is True
    assert len(items) >= 10_000


@pytest.mark.asyncio
async def test_absent_on_404_returns_the_value_when_the_call_succeeds():
    assert await absent_on_404("/docs", AsyncMock(return_value=7)) == 7


@pytest.mark.asyncio
async def test_absent_on_404_stamps_a_404_as_enoent():
    call = AsyncMock(
        side_effect=BoxApiError("Box GET /folders/101 -> 404 not_found", 404)
    )
    with pytest.raises(FileNotFoundError) as caught:
        await absent_on_404("/docs/inner", call)
    assert "/docs/inner" in str(caught.value)


@pytest.mark.asyncio
async def test_absent_on_404_leaves_every_other_status_a_failure():
    for status in (401, 429, 500):
        call = AsyncMock(side_effect=BoxApiError(f"-> {status}", status))
        with pytest.raises(BoxApiError) as caught:
            await absent_on_404("/docs", call)
        assert caught.value.status == status


@pytest.mark.asyncio
async def test_events_since_reads_until_an_empty_page(account):
    # Box may return a short page while more events remain, so only an
    # empty page ends the read: its first page is answered short here.
    await account.mkdir("x")
    await account.put("a.txt", b"a")
    whole = await account.run.call("GET", "/2.0/events?stream_position=0")
    first = whole["entries"][0]
    await account.run.answer_next(
        "GET",
        EVENTS_ROUTE,
        200,
        {"chunk_size": 1, "next_stream_position": 1, "entries": [first]},
    )
    await account.run.record_requests()
    found, position = await events_since(_tm(account), "0", "changes")
    assert found == whole["entries"]
    assert position == whole["next_stream_position"]
    sent = await account.run.params("GET", EVENTS_ROUTE)
    assert [p["stream_position"] for p in sent] == ["0", "1", "2"]
    assert {p["stream_type"] for p in sent} == {"changes"}


@pytest.mark.asyncio
async def test_events_now_returns_the_stream_head(account):
    await account.mkdir("x")
    await account.run.record_requests()
    assert await events_now(_tm(account), "changes") == "1"
    (sent,) = await account.run.params("GET", EVENTS_ROUTE)
    assert sent["stream_position"] == "now"
    head = f'{{"chunk_size": 0, "next_stream_position": {POSITION}, "entries": []}}'
    await account.run.answer_next("GET", EVENTS_ROUTE, 200, head.encode())
    assert await events_now(_tm(account), "changes") == POSITION


@pytest.mark.asyncio
async def test_events_since_sends_back_a_position_as_box_wrote_it(account):
    # A position read into a float comes back as a neighbour, and the next
    # read from it repeats or skips events.
    page = (
        f'{{"chunk_size": 1, "next_stream_position": {POSITION}, '
        '"entries": [{"event_id": "a"}]}'
    )
    await account.run.answer_next("GET", EVENTS_ROUTE, 200, page.encode())
    await account.run.answer_next(
        "GET", EVENTS_ROUTE, 200, {"chunk_size": 0, "entries": []}
    )
    await account.run.record_requests()
    found, position = await events_since(_tm(account), "10", "changes")
    assert ([e["event_id"] for e in found], position) == (["a"], POSITION)
    sent = await account.run.params("GET", EVENTS_ROUTE)
    assert [p["stream_position"] for p in sent] == ["10", POSITION]


@pytest.mark.asyncio
async def test_realtime_server_asks_options_events(account):
    answer = await account.run.call("OPTIONS", "/2.0/events")
    await account.run.record_requests()
    got = await realtime_server(_tm(account))
    assert got["url"] == answer["entries"][0]["url"]
    assert await account.run.requests() == ["OPTIONS /2.0/events"]


@pytest.mark.asyncio
@pytest.mark.parametrize("stuck", [None, "10", 10])
async def test_events_since_refuses_events_that_do_not_advance(account, stuck):
    page = {
        "chunk_size": 1,
        "next_stream_position": stuck,
        "entries": [{"event_id": "a"}],
    }
    await account.run.answer_next("GET", EVENTS_ROUTE, 200, page, times=2)
    await account.run.answer_next("GET", EVENTS_ROUTE, 200, {"entries": []})
    with pytest.raises(RuntimeError, match="did not advance"):
        await events_since(_tm(account), "10", "changes")


@pytest.mark.asyncio
async def test_events_since_keeps_its_position_on_an_empty_page(account):
    await account.run.answer_next(
        "GET",
        EVENTS_ROUTE,
        200,
        {
            "chunk_size": 1,
            "next_stream_position": "11",
            "entries": [{"event_id": "a"}],
        },
    )
    await account.run.answer_next(
        "GET", EVENTS_ROUTE, 200, {"chunk_size": 0, "entries": []}
    )
    found, position = await events_since(_tm(account), "10", "changes")
    assert [e["event_id"] for e in found] == ["a"]
    assert position == "11"


@pytest.mark.asyncio
async def test_events_now_refuses_an_answer_without_a_position(account):
    await account.run.answer_next(
        "GET", EVENTS_ROUTE, 200, {"chunk_size": 0, "entries": []}
    )
    with pytest.raises(RuntimeError, match="next_stream_position"):
        await events_now(_tm(account), "changes")


@pytest.mark.asyncio
async def test_realtime_server_refuses_an_empty_answer(account):
    await account.run.answer_next(
        "OPTIONS", EVENTS_ROUTE, 200, {"chunk_size": 0}
    )
    with pytest.raises(RuntimeError, match="realtime server"):
        await realtime_server(_tm(account))


async def _upload_urls(tm: BoxTokenManager) -> list[str]:
    with patch(
        "mirage.core.box.api.box_upload_multipart",
        new_callable=AsyncMock,
        return_value={},
    ) as mock_upload:
        await upload_new_file(tm, "0", "a.txt", b"a")
        await upload_file_version(tm, "7", "a.txt", b"b")
    return [c.args[1] for c in mock_upload.call_args_list]


@pytest.mark.asyncio
async def test_uploads_go_to_the_upload_host(tm):
    assert await _upload_urls(tm) == [
        "https://upload.box.com/api/2.0/files/content",
        "https://upload.box.com/api/2.0/files/7/content",
    ]


@pytest.mark.asyncio
async def test_folder_calls_stay_on_the_api_host(tm):
    with patch(
        "mirage.core.box.api.box_post_json",
        new_callable=AsyncMock,
        return_value={},
    ) as mock_post:
        await create_folder(tm, "0", "d")
    assert mock_post.call_args.args[1] == "https://api.box.com/2.0/folders"


@pytest.mark.asyncio
async def test_uploads_follow_an_endpoint_override():
    tm = BoxTokenManager(
        BoxConfig(access_token="tok", endpoint="http://127.0.0.1:5096/")
    )
    assert await _upload_urls(tm) == [
        "http://127.0.0.1:5096/2.0/files/content",
        "http://127.0.0.1:5096/2.0/files/7/content",
    ]


async def _refuse(
    exc: BoxApiError, sent: str | None
) -> tuple[KeptVersions, StaleWriteError | None]:
    store = KeptVersions("box")
    prev = bind_caller(
        replace(current_caller(), write_context=store.context())
    )
    try:
        path = PathSpec(virtual="/box/f", directory="/box/", vfs_path="/f")
        got = await refused(path, exc, MatchWrite("s1"), sent)
    finally:
        reset_caller(prev)
    return store, got


@pytest.mark.asyncio
@pytest.mark.parametrize("sent", ["e1", None], ids=["sent", "plain"])
@pytest.mark.parametrize(
    "case", _LOST["box"], ids=[c["name"] for c in _LOST["box"]]
)
async def test_refused_reads_box_answers_like_the_shared_table(case, sent):
    store, got = await _refuse(BoxApiError("x", case["status"]), sent)
    outcome = {"lost": ["s1"], "gone": ["s1"]}.get(case["outcome"])
    if sent is None or outcome is None:
        assert got is None and store.kept == []
    else:
        assert isinstance(got, StaleWriteError) and store.kept == outcome


MIB = 1024 * 1024
UPLOAD = "https://upload.box.com/api/2.0/files"


# Box takes up to 50 MB in one files/content request and opens an upload
# session from 20,000,000 bytes (its API docs, not probed); from 20 MiB an
# upload takes a session whatever holds the bytes.
@pytest.mark.asyncio
@pytest.mark.parametrize("versioning", [False, True], ids=["new", "version"])
@pytest.mark.parametrize("spooled", [False, True], ids=["bytes", "spool"])
@pytest.mark.parametrize("size", [20 * MIB - 1, 20 * MIB])
async def test_a_box_upload_from_20_mib_goes_through_a_session(
    tm, versioning, spooled, size
):
    payload = b"a" * size
    async with ByteSpool() as spool:
        await spool.append(payload)
        data = spool if spooled else payload
        with (
            patch(
                "mirage.core.box.api.box_upload_session",
                new_callable=AsyncMock,
                return_value={"via": "session"},
            ) as session,
            patch(
                "mirage.core.box.api.box_upload_multipart",
                new_callable=AsyncMock,
                return_value={"via": "multipart"},
            ) as multipart,
        ):
            if versioning:
                reply = await upload_file_version(
                    tm, "7", "a.txt", data, '"v1"'
                )
            else:
                reply = await upload_new_file(tm, "0", "a.txt", data)
    if size < 20 * MIB:
        assert reply == {"via": "multipart"}
        session.assert_not_awaited()
        sent = multipart.await_args
        assert sent.args[4] == payload
        assert sent.kwargs.get("headers") == (
            {"If-Match": '"v1"'} if versioning else None
        )
        return
    assert reply == {"via": "session"}
    multipart.assert_not_awaited()
    assert session.await_args.args == (
        (
            tm,
            f"{UPLOAD}/7/upload_sessions",
            {"file_name": "a.txt"},
            data,
            '"v1"',
        )
        if versioning
        else (
            tm,
            f"{UPLOAD}/upload_sessions",
            {"folder_id": "0", "file_name": "a.txt"},
            data,
        )
    )
    # The input itself: a spool is streamed from, never read into memory.
    assert session.await_args.args[3] is data
