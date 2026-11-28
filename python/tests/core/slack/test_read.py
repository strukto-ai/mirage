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
from unittest.mock import patch

import pytest

from mirage.core.render.json import jsonl_bytes
from mirage.core.slack.read import (
    follow,
    read,
    read_many,
    read_range,
    read_stream,
)
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.slack_workspace import DOWNLOAD, HISTORY

pytestmark = pytest.mark.asyncio

CHANNEL = "channels/general__C1"
CHAT = f"/{CHANNEL}/2025-11-03/chat.jsonl"
BLOB = f"/{CHANNEL}/2025-11-05/files/plan__F1.txt"
# general's first day: the deploy at 00:01, then ben's coffee at 01:00.
COFFEE = "1762131600.000001"


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


# The rows the mount hands a read, as the listings name them.
DAY_ROW = FileStat(
    name="2025-11-03", type=FileType.DIRECTORY, extra={"channel_id": "C1"}
)
CHAT_ROW = FileStat(
    name="chat.jsonl", type=FileType.FILE, extra={"channel_id": "C1"}
)
USER_ROW = FileStat(
    name="ana__U1.json", type=FileType.FILE, extra={"user_id": "U1"}
)


def blob_row(workspace) -> FileStat:
    return FileStat(
        name="plan__F1.txt",
        type=FileType.FILE,
        size=5,
        extra={
            "file_id": "F1",
            "mimetype": "text/plain",
            "url_private_download": f"{workspace.run.url}/files/download/F1",
            "channel_id": "C1",
            "date": "2025-11-05",
        },
    )


async def test_read_jsonl(slack_workspace):
    result = await read(
        slack_workspace.accessor(), spec(CHAT), CHAT_ROW, DAY_ROW
    )
    lines = [json.loads(line) for line in result.decode().splitlines()]
    assert [m["text"] for m in lines] == [
        "the deploy is done at acme",
        "coffee is ready",
    ]
    [params] = await slack_workspace.run.params("GET", HISTORY)
    assert (params["channel"], params["oldest"]) == ("C1", "1762128000.000000")


async def test_read_file_blob(slack_workspace):
    data = await read(
        slack_workspace.accessor(), spec(BLOB), blob_row(slack_workspace)
    )
    assert data == b"plan\n"


async def test_read_user_json(slack_workspace):
    result = await read(
        slack_workspace.accessor(), spec("/users/ana__U1.json"), USER_ROW
    )
    parsed = json.loads(result)
    assert (parsed["id"], parsed["name"]) == ("U1", "ana")


async def test_read_not_found(slack_workspace):
    with pytest.raises(FileNotFoundError):
        await read(slack_workspace.accessor(), spec("/nonexistent/path"))


async def test_read_file_blob_pushes_the_window_down(slack_workspace):
    await slack_workspace.run.record_requests("range")
    data = await read_range(
        slack_workspace.accessor(),
        spec(BLOB),
        offset=1,
        size=3,
        entry=blob_row(slack_workspace),
    )
    assert data == b"lan"
    assert await slack_workspace.run.headers("GET", DOWNLOAD) == [
        {"range": "bytes=1-3"}
    ]


async def test_read_jsonl_window_is_sliced_locally(slack_workspace):
    # Rendered history has no remote range, so the window is taken after.
    accessor = slack_workspace.accessor()
    whole = await read(accessor, spec(CHAT), CHAT_ROW, DAY_ROW)
    result = await read_range(
        accessor,
        spec(CHAT),
        offset=1,
        size=6,
        entry=CHAT_ROW,
        parent=DAY_ROW,
    )
    assert result == whole[1:7]


async def test_attachment_stream_closes_before_fetching_tail(slack_workspace):
    # The download is staged: over the wire, a read closed after its first
    # chunk cannot be told from one that fetched the rest.
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
        stream = read_stream(
            slack_workspace.accessor(), spec(BLOB), blob_row(slack_workspace)
        )
        assert await anext(stream) == b"first\n"
        await stream.aclose()
    assert closed == [True]


async def test_follow_prints_the_last_lines_then_asks_after_the_last_seen(
    slack_workspace,
):
    accessor = slack_workspace.accessor()
    stream = await follow(
        accessor, spec(CHAT), 1, 0.001, entry=CHAT_ROW, parent=DAY_ROW
    )
    try:
        first = await anext(stream)
        assert [json.loads(line)["text"] for line in first.splitlines()] == [
            "coffee is ready"
        ]
        [asked] = await slack_workspace.run.params("GET", HISTORY)
        # Another client posts on the day; executing it reloads the run,
        # so the recording restarts after.
        await slack_workspace.run.execute(
            "INSERT INTO Message (tenant, channelId, ts, userId, text, seq) "
            "VALUES ('unit', 'C1', '1762135200.000001', 'U2', 'tea too', 99)"
        )
        await slack_workspace.record()
        added = await anext(stream)
        assert [json.loads(line)["text"] for line in added.splitlines()] == [
            "tea too"
        ]
    finally:
        await stream.aclose()
    assert (asked["channel"], asked["oldest"]) == ("C1", "1762128000.000000")
    after = await slack_workspace.run.params("GET", HISTORY)
    assert after[0]["oldest"] == COFFEE


async def test_only_a_chat_day_is_followed(slack_workspace):
    assert (
        await follow(
            slack_workspace.accessor(), spec("/users/ana__U1.json"), 1, 1.0
        )
        is None
    )


async def test_a_batch_walks_each_run_of_days_once(slack_workspace):
    # 2025-11-03 and 11-04 are one run of days, walked by one listing;
    # 11-07 holds no general message and is walked on its own.
    accessor = slack_workspace.accessor()
    days = ["2025-11-03", "2025-11-04", "2025-11-07"]
    chats = [f"/{CHANNEL}/{day}/chat.jsonl" for day in days]
    chat = FileStat(
        name="chat.jsonl", type=FileType.FILE, extra={"channel_id": "C1"}
    )
    each = {
        c: await read(
            accessor,
            spec(c),
            chat,
            FileStat(
                name=day,
                type=FileType.DIRECTORY,
                extra={"channel_id": "C1"},
            ),
        )
        for c, day in zip(chats, days)
    }
    assert each[chats[2]] == jsonl_bytes([])
    await slack_workspace.record()
    answers = await read_many(
        accessor,
        [spec(c) for c in [*chats, "/users/ana__U1.json"]],
        1 << 20,
        [chat, chat, chat, None],
        [None] * 4,
    )
    assert answers == each
    assert [
        (p["oldest"], p["latest"])
        for p in await slack_workspace.run.params("GET", HISTORY)
    ] == [
        ("1762128000.000000", "1762300800.000000"),
        ("1762473600.000000", "1762560000.000000"),
    ]
    # A day past the limit is left out: the first day's two messages pass
    # a limit the second day's one fits. A run whose messages pass the
    # limit a day stops walking and is left out whole, the second day too
    # though it would fit on its own.
    first, second = len(each[chats[0]]), len(each[chats[1]])
    for size, kept in (
        (first - 1, {chats[1]: each[chats[1]], chats[2]: b""}),
        ((first + second) // 2 - 1, {chats[2]: b""}),
        (1, {chats[2]: b""}),
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
