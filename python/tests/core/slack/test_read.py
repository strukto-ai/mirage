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
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.core.render.json import jsonl_bytes
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.read import (
    follow,
    read,
    read_many,
    read_range,
    read_stream,
)
from mirage.types import FileStat, FileType, PathSpec

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


# The rows the mount hands a read, as the listings name them.
DAY_ROW = FileStat(
    name="2023-11-14", type=FileType.DIRECTORY, extra={"channel_id": "C001"}
)
CHAT_ROW = FileStat(
    name="chat.jsonl",
    type=FileType.FILE,
    size=35,
    extra={"channel_id": "C001"},
)
USER_ROW = FileStat(
    name="alice__U001.json", type=FileType.FILE, extra={"user_id": "U001"}
)
BLOB_ROW = FileStat(
    name="report__F1.pdf",
    type=FileType.FILE,
    size=4096,
    extra={
        "file_id": "F1",
        "mimetype": "application/pdf",
        "url_private_download": "https://files.slack.com/x/report.pdf",
        "channel_id": "C001",
        "date": "2026-04-10",
    },
)


async def test_read_jsonl(accessor):
    history_bytes = b'{"text":"hello","ts":"1700000001"}\n'
    with patch(
        "mirage.core.slack.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=history_bytes,
    ) as mock_hist:
        result = await read(accessor, spec(CHAT), CHAT_ROW, DAY_ROW)

    assert result == history_bytes
    mock_hist.assert_called_once_with(
        accessor.config, "C001", "2023-11-14", accessor.time_range, session=ANY
    )


async def test_read_file_blob(accessor):
    with patch(
        "mirage.core.slack.read.download_file",
        new_callable=AsyncMock,
        return_value=b"%PDF-1.4 fake bytes",
    ):
        data = await read(accessor, spec(BLOB), BLOB_ROW)
    assert data == b"%PDF-1.4 fake bytes"


async def test_read_user_json(accessor):
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
        result = await read(
            accessor, spec("/users/alice__U001.json"), USER_ROW
        )

    parsed = json.loads(result)
    assert parsed["id"] == "U001"
    assert parsed["name"] == "alice"


async def test_read_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/nonexistent/path"))


async def test_read_file_blob_pushes_the_window_down(accessor):
    with patch(
        "mirage.core.slack.read.download_file",
        new_callable=AsyncMock,
        return_value=b"1.4 f",
    ) as mock_dl:
        data = await read_range(
            accessor, spec(BLOB), offset=5, size=5, entry=BLOB_ROW
        )
    assert data == b"1.4 f"
    mock_dl.assert_called_once_with(
        accessor.config,
        "https://files.slack.com/x/report.pdf",
        5,
        5,
        session=ANY,
    )


async def test_read_jsonl_window_is_sliced_locally(accessor):
    # Rendered history has no remote range, so the window is taken after.
    with patch(
        "mirage.core.slack.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=b'{"text":"hello"}\n',
    ):
        result = await read_range(
            accessor,
            spec(CHAT),
            offset=1,
            size=6,
            entry=CHAT_ROW,
            parent=DAY_ROW,
        )
    assert result == b'"text"'


async def test_attachment_stream_closes_before_fetching_tail(accessor):
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
        stream = read_stream(accessor, path, BLOB_ROW)
        assert await anext(stream) == b"first\n"
        await stream.aclose()
    assert closed == [True]


async def test_follow_prints_the_last_lines_then_asks_after_the_last_seen(
    accessor,
):
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
        stream = await follow(
            accessor,
            spec(CHAT),
            1,
            0.001,
            entry=CHAT_ROW,
            parent=DAY_ROW,
        )
        try:
            assert await anext(stream) == jsonl_bytes(first[1:])
            assert await anext(stream) == jsonl_bytes(added)
        finally:
            await stream.aclose()
    assert "after" not in fetch.await_args_list[0].kwargs
    assert fetch.await_args_list[1].kwargs["after"] == "1700000002.000000"
    assert fetch.await_args_list[0].args[1:3] == ("C001", "2023-11-14")


async def test_only_a_chat_day_is_followed(accessor):
    assert (
        await follow(accessor, spec("/users/alice__U001.json"), 1, 1.0) is None
    )


async def _walk(*pages):
    for page in pages:
        yield page


async def test_a_batch_walks_each_run_of_days_once(accessor):
    days = ["2023-11-14", "2023-11-15", "2023-11-17"]
    chats = [f"/{CHANNEL}/{day}/chat.jsonl" for day in days]
    chat = FileStat(
        name="chat.jsonl", type=FileType.FILE, extra={"channel_id": "C001"}
    )
    on_14 = {"text": "a", "ts": "1699999999.000100"}
    on_15 = {"text": "b", "ts": "1700050000.000000"}
    with patch(
        "mirage.core.slack.read.stream_messages_for_day",
        new_callable=MagicMock,
        side_effect=[_walk([on_15], [on_14]), _walk()],
    ) as walk:
        answers = await read_many(
            accessor,
            [spec(c) for c in [*chats, "/users/alice__U001.json"]],
            1 << 20,
            [chat, chat, chat, None],
            [None] * 4,
        )
    assert answers == {
        chats[0]: jsonl_bytes([on_14]),
        chats[1]: jsonl_bytes([on_15]),
        chats[2]: jsonl_bytes([]),
    }
    assert [
        (call.args[2], call.kwargs["last_day"]) for call in walk.call_args_list
    ] == [("2023-11-14", "2023-11-15"), ("2023-11-17", "2023-11-17")]
    # A day past the limit is left out; a run past the limit a day stops
    # walking and is left out whole.
    big = {"text": "a" * 12, "ts": on_14["ts"]}
    limit = len(jsonl_bytes([on_15])) + 10
    for size, kept in (
        (limit, {chats[1]: jsonl_bytes([on_15]), chats[2]: b""}),
        (1, {chats[2]: b""}),
    ):
        with patch(
            "mirage.core.slack.read.stream_messages_for_day",
            new_callable=MagicMock,
            side_effect=[_walk([big, on_15]), _walk()],
        ):
            assert (
                await read_many(
                    accessor,
                    [spec(c) for c in chats],
                    size,
                    [chat] * 3,
                    [None] * 3,
                )
                == kept
            )
