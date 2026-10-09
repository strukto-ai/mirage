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


@pytest.fixture
def tm():
    return BoxTokenManager(BoxConfig(access_token="tok"))


@pytest.mark.asyncio
async def test_list_folder_items_follows_offset_pagination(tm):
    pages = [
        {
            "total_count": 3,
            "entries": [
                {"id": "1", "name": "a", "type": "file"},
                {"id": "2", "name": "b", "type": "file"},
            ],
        },
        {
            "total_count": 3,
            "entries": [{"id": "3", "name": "c", "type": "file"}],
        },
    ]
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        side_effect=pages,
    ) as mock_get:
        items = await list_folder_items(tm, "0", limit=2)
    assert [it["id"] for it in items] == ["1", "2", "3"]
    assert mock_get.await_count == 2
    _, second = mock_get.await_args_list[1]
    assert second["params"]["offset"] == 2


@pytest.mark.asyncio
async def test_list_folder_items_stops_on_empty_page(tm):
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        return_value={"total_count": 5, "entries": []},
    ) as mock_get:
        items = await list_folder_items(tm, "0")
    assert items == []
    assert mock_get.await_count == 1


@pytest.mark.asyncio
async def test_search_content_scopes_and_matches_content(tm):
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        return_value={
            "total_count": 1,
            "entries": [{"id": "9", "name": "hit", "type": "file"}],
        },
    ) as mock_get:
        items, truncated = await search_content(tm, "needle", "42")
    assert items[0]["id"] == "9"
    assert truncated is False
    _, kwargs = mock_get.await_args
    assert kwargs["params"]["ancestor_folder_ids"] == "42"
    assert kwargs["params"]["content_types"] == "name,file_content"
    assert kwargs["params"]["type"] == "file"
    assert kwargs["params"]["fields"] == SEARCH_FIELDS


@pytest.mark.asyncio
async def test_search_content_flags_truncation_at_ceiling(tm):
    page = {
        "total_count": 20_000,
        "entries": [
            {"id": str(i), "name": "f", "type": "file"} for i in range(200)
        ],
    }
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        return_value=page,
    ):
        items, truncated = await search_content(tm, "q", "0")
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
async def test_events_since_reads_until_an_empty_page(tm):
    # Box may return a short page while more events remain, so only an
    # empty page ends the read.
    pages = [
        {
            "chunk_size": 1,
            "next_stream_position": 11,
            "entries": [{"event_id": "a"}],
        },
        {
            "chunk_size": 1,
            "next_stream_position": "12",
            "entries": [{"event_id": "b"}],
        },
        {"chunk_size": 0, "next_stream_position": "12", "entries": []},
    ]
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        side_effect=pages,
    ) as mock_get:
        found, position = await events_since(tm, "10", "changes")
    assert [e["event_id"] for e in found] == ["a", "b"]
    assert position == "12"
    positions = [
        call.kwargs["params"]["stream_position"]
        for call in mock_get.await_args_list
    ]
    assert positions == ["10", "11", "12"]
    assert (
        mock_get.await_args_list[0].args[1] == "https://api.box.com/2.0/events"
    )
    assert mock_get.await_args_list[0].kwargs["params"]["stream_type"] == (
        "changes"
    )


@pytest.mark.asyncio
async def test_events_now_returns_the_stream_head(tm):
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        return_value={
            "chunk_size": 0,
            "next_stream_position": 1152922976252290886,
            "entries": [],
        },
    ) as mock_get:
        position = await events_now(tm, "changes")
    assert position == "1152922976252290886"
    assert mock_get.await_args.kwargs["params"]["stream_position"] == "now"


@pytest.mark.asyncio
async def test_realtime_server_asks_options_events(tm):
    server = {
        "type": "realtime_server",
        "url": "http://2.realtime.services.box.net/subscribe?channel=c",
        "ttl": "10",
        "max_retries": "10",
        "retry_timeout": 610,
    }
    with patch(
        "mirage.core.box.api.box_options",
        new_callable=AsyncMock,
        return_value={"chunk_size": 1, "entries": [server]},
    ) as mock_options:
        got = await realtime_server(tm)
    assert got["url"] == server["url"]
    assert mock_options.await_args.args[1] == "https://api.box.com/2.0/events"


@pytest.mark.asyncio
@pytest.mark.parametrize("stuck", [None, "10", 10])
async def test_events_since_refuses_events_that_do_not_advance(tm, stuck):
    page = {
        "chunk_size": 1,
        "next_stream_position": stuck,
        "entries": [{"event_id": "a"}],
    }
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        side_effect=[page, page, {"entries": []}],
    ):
        with pytest.raises(RuntimeError, match="did not advance"):
            await events_since(tm, "10", "changes")


@pytest.mark.asyncio
async def test_events_since_keeps_its_position_on_an_empty_page(tm):
    pages = [
        {
            "chunk_size": 1,
            "next_stream_position": "11",
            "entries": [{"event_id": "a"}],
        },
        {"chunk_size": 0, "entries": []},
    ]
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        side_effect=pages,
    ):
        found, position = await events_since(tm, "10", "changes")
    assert [e["event_id"] for e in found] == ["a"]
    assert position == "11"


@pytest.mark.asyncio
async def test_events_now_refuses_an_answer_without_a_position(tm):
    with patch(
        "mirage.core.box.api.box_get",
        new_callable=AsyncMock,
        return_value={"chunk_size": 0, "entries": []},
    ):
        with pytest.raises(RuntimeError, match="next_stream_position"):
            await events_now(tm, "changes")


@pytest.mark.asyncio
async def test_realtime_server_refuses_an_empty_answer(tm):
    with patch(
        "mirage.core.box.api.box_options",
        new_callable=AsyncMock,
        return_value={"chunk_size": 0},
    ):
        with pytest.raises(RuntimeError, match="realtime server"):
            await realtime_server(tm)


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
    prev = push_write_context(store.context())
    try:
        path = PathSpec(virtual="/box/f", directory="/box/", vfs_path="/f")
        got = await refused(path, exc, WriteCondition("s1"), sent)
    finally:
        push_write_context(prev)
    return store, got


@pytest.mark.asyncio
@pytest.mark.parametrize("sent", ["e1", None], ids=["sent", "plain"])
@pytest.mark.parametrize(
    "case", _LOST["box"], ids=[c["name"] for c in _LOST["box"]]
)
async def test_refused_reads_box_answers_like_the_shared_table(case, sent):
    store, got = await _refuse(BoxApiError("x", case["status"]), sent)
    outcome = {"lost": ["s1"], "gone": []}.get(case["outcome"])
    if sent is None or outcome is None:
        assert got is None and store.kept == []
    else:
        assert isinstance(got, StaleWriteError) and store.kept == outcome
