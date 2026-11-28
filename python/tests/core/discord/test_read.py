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
from unittest.mock import patch

import pytest

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.scope import command_scope
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
from tests.fixtures.discord_guild import (
    ALICE,
    ATTACHMENT,
    DAY,
    GENERAL,
    GUILD_DIR,
    MESSAGES,
    PAGE,
    DiscordGuild,
)
from tests.fixtures.handed import call, entry_at, parent_of
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio


async def read(accessor: DiscordAccessor, path: PathSpec) -> bytes:
    return await mounted(DiscordVFS, accessor).read(path)


CHANNEL = f"{GUILD_DIR}/channels/general__211"
CHAT = f"/{CHANNEL}/{DAY}/chat.jsonl"
REFUSED_DAY = "2024-01-13"


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def _day_bytes(guild: DiscordGuild, day: str = DAY) -> bytes:
    """general's chat.jsonl for ``day``: Discord's own messages, oldest
    first."""
    return jsonl_bytes(await guild.day(GENERAL, day))


async def test_read_jsonl(discord_guild, accessor):
    # Cold: no prior listing is needed, the mount lists the chain down
    # to the day itself.
    result = await read(accessor, spec(CHAT))
    assert result == await _day_bytes(discord_guild)


async def test_read_jsonl_walks_every_page_of_a_busy_day(
    discord_guild, accessor
):
    # More messages in one day than Discord answers a page: the read
    # walks on past the first page and keeps them all, oldest first.
    busy = "2024-01-17"
    start = datetime(2024, 1, 17, 8, tzinfo=timezone.utc).timestamp()
    posts = [
        (datetime.fromtimestamp(start + n, timezone.utc), f"busy {n}")
        for n in range(PAGE + 5)
    ]
    await discord_guild.add_messages(GENERAL, ALICE, posts)
    result = await read(accessor, spec(f"/{CHANNEL}/{busy}/chat.jsonl"))
    rows = [json.loads(line) for line in result.splitlines()]
    assert [r["content"] for r in rows] == [text for _, text in posts]
    assert result == await _day_bytes(discord_guild, busy)


# The mount lists the day before it reads chat.jsonl, and the read takes
# the messages that listing fetched instead of fetching the day again.
async def test_a_read_takes_the_day_its_listing_fetched(
    discord_guild, accessor
):
    async with command_scope():
        assert await read(accessor, spec(CHAT)) == await _day_bytes(
            discord_guild
        )
    assert await discord_guild.day_fetches() == [(GENERAL, DAY)]


async def _read_chat(accessor: DiscordAccessor) -> bytes:
    chat = FileStat(
        name="chat.jsonl", type=FileType.FILE, extra={"channel_id": GENERAL}
    )
    return b"".join([c async for c in read_stream(accessor, spec(CHAT), chat)])


# Only the last listed day is kept, and one read takes it: reading the
# day again, or after another day was listed, fetches it.
async def test_only_the_last_listed_day_is_kept_for_one_read(
    discord_guild, accessor
):
    m = mounted(DiscordVFS, accessor)
    whole = await _day_bytes(discord_guild)
    async with command_scope():
        await m.readdir(f"/{CHANNEL}/{DAY}")
        assert await _read_chat(accessor) == whole
        assert await _read_chat(accessor) == whole
        await m.readdir(f"/{CHANNEL}/2024-01-14")
        assert await m.read(CHAT) == whole
    assert await discord_guild.day_fetches() == [
        (GENERAL, DAY),
        (GENERAL, DAY),
        (GENERAL, "2024-01-14"),
        (GENERAL, DAY),
    ]


# A write past the dispatcher drops the kept day with the mount's caches,
# a fresh mount keeps none, and a day is kept no longer than a fetch
# counts as current, so each read fetches the day.
@pytest.mark.parametrize("drop", ["forget", "fresh", "late"])
async def test_a_dropped_or_expired_day_is_fetched_again(
    discord_guild, accessor, drop, monkeypatch
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
        assert await _read_chat(accessor) == await _day_bytes(discord_guild)
    assert await discord_guild.day_fetches() == [
        (GENERAL, DAY),
        (GENERAL, DAY),
    ]


# The kept day serves only the command that listed it, so a read that
# comes later asks Discord, a direct one included: a read in the next
# command fetches the day again, and outside any command (FUSE, a
# programmatic op) nothing is kept.
@pytest.mark.parametrize(
    "scope", [command_scope, nullcontext], ids=["next command", "no command"]
)
async def test_only_the_listing_command_takes_the_day(
    discord_guild, accessor, scope
):
    async with scope():
        await mounted(DiscordVFS, accessor).readdir(f"/{CHANNEL}/{DAY}")
    async with scope():
        assert await _read_chat(accessor) == await _day_bytes(discord_guild)
    assert await discord_guild.day_fetches() == [
        (GENERAL, DAY),
        (GENERAL, DAY),
    ]


async def test_read_jsonl_bogus_channel_is_enoent(accessor):
    # The typed `name__id` is only trusted once the listing proves it, so
    # a fabricated channel id is ENOENT rather than a raw API error.
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            spec(f"/{GUILD_DIR}/channels/nope__9/{DAY}/chat.jsonl"),
        )


async def test_read_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/no/such/path"))


async def test_read_jsonl_window_is_sliced_locally(discord_guild, accessor):
    # A rendered branch has no remote range, so the window is taken after.
    whole = await _day_bytes(discord_guild)
    result = await call(
        read_range, readdir, accessor, spec(CHAT), offset=1, size=4
    )
    assert result == whole[1:5]


async def test_read_chat_on_a_refused_day_is_eacces(discord_guild, accessor):
    await discord_guild.refuse(MESSAGES, 403)
    with pytest.raises(PermissionError):
        await read(accessor, spec(f"/{CHANNEL}/{REFUSED_DAY}/chat.jsonl"))


async def test_read_member_json(accessor):
    data = await read(accessor, spec(f"/{GUILD_DIR}/members/alice__311.json"))
    payload = json.loads(data)
    assert payload["user"]["id"] == ALICE


async def test_read_blob_pushes_the_range_to_the_source(
    discord_guild, accessor
):
    path = spec(f"/{CHANNEL}/{DAY}/files/kept__A1.txt")
    handed = await entry_at(readdir, accessor, path)
    await discord_guild.run.record_requests("range")
    result = await read_range(accessor, path, offset=2, size=3, entry=handed)
    assert result == b"234"
    assert await discord_guild.run.headers("GET", ATTACHMENT) == [
        {"range": "bytes=2-4"}
    ]


async def test_read_dir_is_enoent_when_unproven(accessor):
    # A matched shape alone is no existence proof: reading a directory
    # kind answers "No such file" unless the node exists by construction.
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/Nope__9"))


async def test_read_tombstoned_attachment_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor, spec(f"/{CHANNEL}/{DAY}/files/tombstoned__A2.txt")
        )


async def test_attachment_stream_closes_before_fetching_tail(accessor):
    # The download is staged: over the wire, a read closed after its
    # first chunk cannot be told from one that fetched the rest.
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
    discord_guild, accessor
):
    day = await discord_guild.day(GENERAL, DAY)
    stream = await follow(
        accessor,
        spec(CHAT),
        1,
        0.001,
        entry=await entry_at(readdir, accessor, spec(CHAT)),
        parent=await entry_at(readdir, accessor, parent_of(spec(CHAT))),
    )
    try:
        assert await anext(stream) == jsonl_bytes(day[-1:])
        # The listing above the day fetched it too; the last look is the
        # follow's own.
        first = (await discord_guild.run.params("GET", MESSAGES))[-1]
        added = await discord_guild.add_message(
            GENERAL,
            datetime(2024, 1, 15, 12, tzinfo=timezone.utc),
            ALICE,
            "later",
        )
        assert await anext(stream) == jsonl_bytes([added])
    finally:
        await stream.aclose()
    # The first look starts at the day, the next after the last one seen.
    start = datetime(2024, 1, 15, tzinfo=timezone.utc).timestamp()
    assert int(first["after"]) == snowflake_at(start) - 1
    later = await discord_guild.run.params("GET", MESSAGES)
    assert later[0]["after"] == day[-1]["id"]


async def test_only_a_chat_day_is_followed(accessor):
    member = f"/{GUILD_DIR}/members/alice__311.json"
    assert await follow(accessor, spec(member), 1, 1.0) is None


async def test_a_batch_walks_a_run_of_days_once(discord_guild, accessor):
    # 2024-01-15 and 01-16 are one run of days, walked by one listing.
    nxt = "2024-01-16"
    chats = [CHAT, f"/{CHANNEL}/{nxt}/chat.jsonl"]
    chat = FileStat(
        name="chat.jsonl", type=FileType.FILE, extra={"channel_id": GENERAL}
    )
    answers = await read_many(
        accessor, [spec(c) for c in chats], 1 << 20, [chat] * 2, [None] * 2
    )
    assert answers == {
        chats[0]: await _day_bytes(discord_guild),
        chats[1]: await _day_bytes(discord_guild, nxt),
    }
    assert await discord_guild.day_fetches() == [(GENERAL, DAY)]
