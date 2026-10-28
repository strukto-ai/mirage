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
import time
from contextlib import nullcontext
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.scope import command_scope
from mirage.core.api.errors import ApiError
from mirage.core.discord.history import snowflake_at
from mirage.core.discord.read import (
    follow,
    read_many,
    read_range,
    read_stream,
)
from mirage.core.discord.readdir import readdir
from mirage.core.render.json import jsonl_bytes
from mirage.types import (
    FileStat,
    FileType,
    PathSpec,
    ReadPolicy,
    ReadSpec,
)
from mirage.vfs.discord import DiscordVFS
from tests.core.discord.conftest import DAY, MESSAGES, SEALED_DAY
from tests.fixtures.handed import call, entry_at, parent_of
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio


async def read(accessor: DiscordAccessor, path: PathSpec) -> bytes:
    return await mounted(DiscordVFS, accessor).read(path)


GUILD_DIR = "My Server__G001"
CHANNEL = f"{GUILD_DIR}/channels/general__C001"
CHAT = f"/{CHANNEL}/{DAY}/chat.jsonl"


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def test_read_jsonl(api, accessor):
    # Cold: no prior listing is needed, the mount lists the chain down
    # to the day itself.
    result = await read(accessor, spec(CHAT))
    assert result == jsonl_bytes(MESSAGES)


# The mount lists the day before it reads chat.jsonl, and the read takes
# the messages that listing fetched instead of fetching the day again.
async def test_a_read_takes_the_day_its_listing_fetched(api, accessor):
    async with command_scope():
        assert await read(accessor, spec(CHAT)) == jsonl_bytes(MESSAGES)
    assert api.day_fetches == [("C001", DAY)]


async def _read_chat(accessor: DiscordAccessor) -> bytes:
    chat = FileStat(
        name="chat.jsonl", type=FileType.FILE, extra={"channel_id": "C001"}
    )
    return b"".join([c async for c in read_stream(accessor, spec(CHAT), chat)])


# Only the last listed day is kept, and one read takes it: reading the
# day again, or after another day was listed, fetches it.
async def test_only_the_last_listed_day_is_kept_for_one_read(api, accessor):
    m = mounted(DiscordVFS, accessor)
    async with command_scope():
        await m.readdir(f"/{CHANNEL}/{DAY}")
        assert await _read_chat(accessor) == jsonl_bytes(MESSAGES)
        assert await _read_chat(accessor) == jsonl_bytes(MESSAGES)
        await m.readdir(f"/{CHANNEL}/2024-01-14")
        assert await m.read(CHAT) == jsonl_bytes(MESSAGES)
    assert api.day_fetches == [
        ("C001", DAY),
        ("C001", DAY),
        ("C001", "2024-01-14"),
        ("C001", DAY),
    ]


# A write past the dispatcher drops the kept day with the mount's caches,
# a fresh mount keeps none, and a day is kept no longer than a fetch
# counts as current, so each read fetches the day.
@pytest.mark.parametrize("drop", ["forget", "fresh", "late"])
async def test_a_dropped_or_expired_day_is_fetched_again(
    api, accessor, drop, monkeypatch
):
    real = time.monotonic
    offset = [0.0]
    monkeypatch.setattr(
        "mirage.accessor.responses.time.monotonic", lambda: real() + offset[0]
    )
    if drop == "fresh":
        accessor.govern(ReadSpec(policy=ReadPolicy.FRESH))
    async with command_scope():
        await mounted(DiscordVFS, accessor).readdir(f"/{CHANNEL}/{DAY}")
        if drop == "forget":
            accessor.forget()
        if drop == "late":
            offset[0] = LISTING_TRUST_WINDOW
        assert await _read_chat(accessor) == jsonl_bytes(MESSAGES)
    assert api.day_fetches == [("C001", DAY), ("C001", DAY)]


# The kept day serves only the command that listed it, so a read that
# comes later asks Discord, a direct one included: a read in the next
# command fetches the day again, and outside any command (FUSE, a
# programmatic op) nothing is kept.
@pytest.mark.parametrize(
    "scope", [command_scope, nullcontext], ids=["next command", "no command"]
)
async def test_only_the_listing_command_takes_the_day(api, accessor, scope):
    async with scope():
        await mounted(DiscordVFS, accessor).readdir(f"/{CHANNEL}/{DAY}")
    async with scope():
        assert await _read_chat(accessor) == jsonl_bytes(MESSAGES)
    assert api.day_fetches == [("C001", DAY), ("C001", DAY)]


async def test_read_jsonl_bogus_channel_is_enoent(api, accessor):
    # The typed `name__id` is only trusted once the listing proves it, so
    # a fabricated channel id is ENOENT rather than a raw API error.
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            spec(f"/{GUILD_DIR}/channels/nope__C9/{DAY}/chat.jsonl"),
        )


async def test_read_not_found(api, accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/no/such/path"))


async def test_read_jsonl_window_is_sliced_locally(api, accessor):
    # A rendered branch has no remote range, so the window is taken after.
    whole = jsonl_bytes(MESSAGES)
    result = await call(
        read_range, readdir, accessor, spec(CHAT), offset=1, size=4
    )
    assert result == whole[1:5]


async def test_read_chat_on_a_sealed_day_reproduces_the_api_answer(
    api, accessor
):
    # The sealed day lists nothing but the file still reads through the
    # channel; the fetch then answers what the API answers.

    with pytest.raises(ApiError):
        await read(accessor, spec(f"/{CHANNEL}/{SEALED_DAY}/chat.jsonl"))


async def test_read_member_json(api, accessor):
    data = await read(accessor, spec(f"/{GUILD_DIR}/members/alice__U001.json"))
    payload = json.loads(data)
    assert payload["user"]["id"] == "U001"


async def test_read_blob_pushes_the_range_to_the_source(api, accessor):
    result = await call(
        read_range,
        readdir,
        accessor,
        spec(f"/{CHANNEL}/{DAY}/files/kept__A1.txt"),
        offset=2,
        size=3,
    )
    assert result == b"234"
    assert api.downloads == [("https://cdn.example/kept.txt", 2, 3)]


async def test_read_dir_is_enoent_when_unproven(api, accessor):
    # A matched shape alone is no existence proof: reading a directory
    # kind answers "No such file" unless the node exists by construction.
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/Nope__G9"))


async def test_read_tombstoned_attachment_is_enoent(api, accessor):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor, spec(f"/{CHANNEL}/{DAY}/files/tombstoned__A2.txt")
        )


async def test_attachment_stream_closes_before_fetching_tail(api, accessor):
    path = spec(f"/{CHANNEL}/{DAY}/files/kept__A1.txt")
    closed = []

    async def source():
        try:
            yield b"first\n"
            raise AssertionError("fetched tail")
        finally:
            closed.append(True)

    with patch(
        "mirage.core.discord.read.download_file_stream", return_value=source()
    ):
        stream = read_stream(
            accessor, path, await entry_at(readdir, accessor, path)
        )
        assert await anext(stream) == b"first\n"
        await stream.aclose()
    assert closed == [True]


async def test_follow_prints_the_last_lines_then_asks_after_the_last_seen(
    api, accessor
):
    added = [{"id": "1196242344345600900", "content": "later"}]
    with patch(
        "mirage.core.discord.read.list_messages_for_day",
        new_callable=AsyncMock,
        side_effect=[[dict(m) for m in MESSAGES], added, []],
    ) as fetch:
        stream = await follow(
            accessor,
            spec(CHAT),
            1,
            0.001,
            entry=await entry_at(readdir, accessor, spec(CHAT)),
            parent=await entry_at(readdir, accessor, parent_of(spec(CHAT))),
        )
        try:
            assert await anext(stream) == jsonl_bytes(MESSAGES[-1:])
            assert await anext(stream) == jsonl_bytes(added)
        finally:
            await stream.aclose()
    assert "after" not in fetch.await_args_list[0].kwargs
    assert fetch.await_args_list[1].kwargs["after"] == MESSAGES[-1]["id"]


async def test_only_a_chat_day_is_followed(api, accessor):
    member = f"/{GUILD_DIR}/members/alice__U001.json"
    assert await follow(accessor, spec(member), 1, 1.0) is None


async def _walk(*pages):
    for page in pages:
        yield page


async def test_a_batch_walks_a_run_of_days_once(api, accessor):
    nxt = "2024-01-16"
    on_day, later = (
        {
            "id": str(
                snowflake_at(datetime(*at, tzinfo=timezone.utc).timestamp())
            ),
            "content": text,
        }
        for at, text in (((2024, 1, 15, 10), "a"), ((2024, 1, 16, 1), "b"))
    )
    chats = [CHAT, f"/{CHANNEL}/{nxt}/chat.jsonl"]
    with patch(
        "mirage.core.discord.read.stream_messages_for_day",
        new_callable=MagicMock,
        return_value=_walk([later], [on_day]),
    ) as walk:
        chat = FileStat(
            name="chat.jsonl", type=FileType.FILE, extra={"channel_id": "C001"}
        )
        answers = await read_many(
            accessor, [spec(c) for c in chats], 1 << 20, [chat] * 2, [None] * 2
        )
    assert answers == {
        chats[0]: jsonl_bytes([on_day]),
        chats[1]: jsonl_bytes([later]),
    }
    assert [
        (call.args[2], call.kwargs["last_day"]) for call in walk.call_args_list
    ] == [(DAY, nxt)]
