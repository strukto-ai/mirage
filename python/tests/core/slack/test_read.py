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
from unittest.mock import ANY, AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.render.json import jsonl_bytes
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.read import (
    follow,
    read,
    read_many,
    read_range,
    read_stream,
)
from mirage.types import PathSpec

pytestmark = pytest.mark.asyncio

CHANNEL = "channels/general__C001"
CHAT = f"/{CHANNEL}/2023-11-14/chat.jsonl"
BLOB = f"/{CHANNEL}/2026-04-10/files/report__F1.pdf"


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config=config)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


async def _populate_index(index: RAMIndexCacheStore) -> RAMIndexCacheStore:
    await index.set_dir(
        "/channels",
        [
            (
                "general__C001",
                IndexEntry(
                    id="C001",
                    name="general",
                    resource_type="slack/channel",
                    vfs_name="general__C001",
                ),
            ),
        ],
    )
    await index.set_dir(
        f"/{CHANNEL}/2023-11-14",
        [
            (
                "chat.jsonl",
                IndexEntry(
                    id="C001:2023-11-14:chat",
                    name="chat.jsonl",
                    resource_type="slack/chat_jsonl",
                    vfs_name="chat.jsonl",
                    size=35,
                ),
            ),
        ],
    )
    await index.set_dir(
        "/users",
        [
            (
                "alice__U001.json",
                IndexEntry(
                    id="U001",
                    name="alice",
                    resource_type="slack/user",
                    vfs_name="alice__U001.json",
                ),
            ),
        ],
    )
    await index.set_dir(
        f"/{CHANNEL}/2026-04-10/files",
        [
            (
                "report__F1.pdf",
                IndexEntry(
                    id="F1",
                    name="report.pdf",
                    resource_type="slack/file",
                    vfs_name="report__F1.pdf",
                    size=4096,
                    extra={
                        "mimetype": "application/pdf",
                        "url_private_download": "https://files.slack.com/x/report.pdf",
                        "channel_id": "C001",
                        "date": "2026-04-10",
                    },
                ),
            ),
        ],
    )
    return index


async def test_read_jsonl(accessor, index):
    await _populate_index(index)
    history_bytes = b'{"text":"hello","ts":"1700000001"}\n'
    with patch(
        "mirage.core.slack.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=history_bytes,
    ) as mock_hist:
        result = await read(accessor, spec(CHAT), index)

    assert result == history_bytes
    mock_hist.assert_called_once_with(
        accessor.config, "C001", "2023-11-14", accessor.time_range, session=ANY
    )


async def test_read_file_blob(accessor, index):
    await _populate_index(index)
    with patch(
        "mirage.core.slack.read.download_file",
        new_callable=AsyncMock,
        return_value=b"%PDF-1.4 fake bytes",
    ):
        data = await read(accessor, spec(BLOB), index)
    assert data == b"%PDF-1.4 fake bytes"


async def test_read_user_json(accessor, index):
    await _populate_index(index)
    user_data = {
        "id": "U001",
        "name": "alice",
        "real_name": "Alice Smith",
    }
    with patch(
        "mirage.core.slack.read.get_user_profile",
        new_callable=AsyncMock,
        return_value=user_data,
    ):
        result = await read(accessor, spec("/users/alice__U001.json"), index)

    parsed = json.loads(result)
    assert parsed["id"] == "U001"
    assert parsed["name"] == "alice"


async def test_read_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/nonexistent/path"), index)


async def test_read_file_blob_pushes_the_window_down(accessor, index):
    await _populate_index(index)
    with patch(
        "mirage.core.slack.read.download_file",
        new_callable=AsyncMock,
        return_value=b"1.4 f",
    ) as mock_dl:
        data = await read_range(accessor, spec(BLOB), index, offset=5, size=5)
    assert data == b"1.4 f"
    mock_dl.assert_called_once_with(
        accessor.config,
        "https://files.slack.com/x/report.pdf",
        5,
        5,
        session=ANY,
    )


async def test_read_jsonl_window_is_sliced_locally(accessor, index):
    # Rendered history has no remote range, so the window is taken after.
    await _populate_index(index)
    with patch(
        "mirage.core.slack.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=b'{"text":"hello"}\n',
    ):
        result = await read_range(
            accessor, spec(CHAT), index, offset=1, size=6
        )
    assert result == b'"text"'


async def test_attachment_stream_closes_before_fetching_tail(accessor, index):
    await _populate_index(index)
    path = spec(BLOB)
    closed = []

    async def source():
        try:
            yield b"first\n"
            raise AssertionError("fetched tail")
        finally:
            closed.append(True)

    with patch(
        "mirage.core.slack.read.download_file_stream", return_value=source()
    ):
        stream = read_stream(accessor, path, index)
        assert await anext(stream) == b"first\n"
        await stream.aclose()
    assert closed == [True]


async def test_follow_prints_the_last_lines_then_asks_after_the_last_seen(
    accessor, index
):
    await _populate_index(index)
    first = [
        {"text": "a", "ts": "1700000001.000000"},
        {"text": "b", "ts": "1700000002.000000"},
    ]
    added = [{"text": "c", "ts": "1700000003.000000"}]
    with patch(
        "mirage.core.slack.read.fetch_messages_for_day",
        new_callable=AsyncMock,
        side_effect=[first, added, []],
    ) as fetch:
        stream = await follow(accessor, spec(CHAT), 1, 0.001, index)
        try:
            assert await anext(stream) == jsonl_bytes(first[1:])
            assert await anext(stream) == jsonl_bytes(added)
        finally:
            await stream.aclose()
    assert "after" not in fetch.await_args_list[0].kwargs
    assert fetch.await_args_list[1].kwargs["after"] == "1700000002.000000"
    assert fetch.await_args_list[0].args[1:3] == ("C001", "2023-11-14")


async def test_only_a_chat_day_is_followed(accessor, index):
    await _populate_index(index)
    assert (
        await follow(accessor, spec("/users/alice__U001.json"), 1, 1.0, index)
        is None
    )


async def test_a_batch_walks_each_run_of_days_once(accessor, index):
    await _populate_index(index)
    days = ["2023-11-14", "2023-11-15", "2023-11-17"]
    chats = [f"/{CHANNEL}/{day}/chat.jsonl" for day in days]
    for day in days[1:]:
        await index.set_dir(
            f"/{CHANNEL}/{day}",
            [
                (
                    "chat.jsonl",
                    IndexEntry(
                        id=f"C001:{day}:chat",
                        name="chat.jsonl",
                        resource_type="slack/chat_jsonl",
                        vfs_name="chat.jsonl",
                    ),
                )
            ],
        )
    on_14 = {"text": "a", "ts": "1699999999.000100"}
    on_15 = {"text": "b", "ts": "1700050000.000000"}
    with patch(
        "mirage.core.slack.read.fetch_messages_for_day",
        new_callable=AsyncMock,
        side_effect=[[on_14, on_15], []],
    ) as fetch:
        answers = await read_many(
            accessor,
            [spec(c) for c in [*chats, "/users/alice__U001.json"]],
            index,
        )
    assert answers == {
        chats[0]: jsonl_bytes([on_14]),
        chats[1]: jsonl_bytes([on_15]),
        chats[2]: jsonl_bytes([]),
    }
    assert [
        (call.args[2], call.kwargs["last_day"])
        for call in fetch.call_args_list
    ] == [("2023-11-14", "2023-11-15"), ("2023-11-17", "2023-11-17")]
