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

from datetime import datetime, timezone

import pytest

from mirage.core.discord.events import DiscordEventHook
from mirage.core.discord.history import snowflake_at
from mirage.types import FileChangeKind, PathSpec
from tests.fixtures.discord_guild import DiscordGuild

C, U, D, X = (
    FileChangeKind.CREATE,
    FileChangeKind.UPDATE,
    FileChangeKind.DELETE,
    FileChangeKind.UNKNOWN,
)
GUILD_DIR = "/d/My Server__111"
CHANNEL_DIR = f"{GUILD_DIR}/channels/general__211"

pytestmark = pytest.mark.asyncio


def _id(year: int, month: int, day: int, hour: int = 12) -> str:
    stamp = datetime(year, month, day, hour, tzinfo=timezone.utc)
    return str(snowflake_at(stamp.timestamp()))


OLD = _id(2026, 9, 20)
LATE = _id(2026, 10, 1, 23)
# A thread started from a message shares its id, so it names its starter's
# day.
THREAD_ID = _id(2026, 9, 28)
VOICE = "555"
# A channel of a guild the bot's listing does not hold.
STRAY = "300"


def _root() -> PathSpec:
    return PathSpec(virtual="/d", directory="/d", vfs_path="")


async def _channel(
    guild: DiscordGuild,
    channel: str,
    name: str,
    kind: int,
    guild_id: str = "111",
    parent: str | None = None,
) -> None:
    # A channel the unit world does not hold, stored as another client
    # would have made it.
    await guild.run.execute(
        "INSERT INTO DiscordChannel (tenant, id, guildId, seq, name, type, "
        "position, parentId) VALUES ('default', ?, ?, 99, ?, ?, 9, ?)",
        channel,
        guild_id,
        name,
        kind,
        parent,
    )
    await guild.run.record_requests()


async def _hook(guild: DiscordGuild) -> DiscordEventHook:
    await _channel(guild, THREAD_ID, "a thread", 11, parent="211")
    await _channel(guild, VOICE, "voice", 2)
    await _channel(guild, STRAY, "elsewhere", 0, guild_id="901")
    return DiscordEventHook(guild.accessor())


async def _map(hook, event_type, payload) -> list[tuple[FileChangeKind, str]]:
    events = await hook.to_events(_root(), event_type, payload)
    return [(e.kind, e.path.virtual) for e in events]


async def _lookups(guild: DiscordGuild) -> list[str]:
    return [r.split(" ", 1)[1] for r in await guild.run.requests()]


async def test_a_message_updates_the_utc_day_its_id_was_minted_on(
    discord_guild,
):
    hook = await _hook(discord_guild)
    found = await _map(
        hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "211"}
    )
    assert found == [(U, f"{CHANNEL_DIR}/2026-10-01/chat.jsonl")]


async def test_a_new_messages_listed_attachments_are_created(discord_guild):
    hook = await _hook(discord_guild)
    attachments = [
        {"id": "7", "filename": "plan.pdf", "url": "u", "size": 3},
        {"id": "8", "filename": "gone.png"},
    ]
    found = await _map(
        hook,
        "MESSAGE_CREATE",
        {"id": LATE, "channel_id": "211", "attachments": attachments},
    )
    assert found == [
        (U, f"{CHANNEL_DIR}/2026-10-01/chat.jsonl"),
        (C, f"{CHANNEL_DIR}/2026-10-01/files/plan__7.pdf"),
    ]


async def test_an_edit_or_delete_refreshes_the_day_the_message_was_posted(
    discord_guild,
):
    hook = await _hook(discord_guild)
    day = f"{CHANNEL_DIR}/2026-09-20"
    expected = [(U, f"{day}/chat.jsonl"), (X, f"{day}/files")]
    for kind in ("MESSAGE_UPDATE", "MESSAGE_DELETE"):
        found = await _map(hook, kind, {"id": OLD, "channel_id": "211"})
        assert found == expected


async def test_a_bulk_delete_names_each_day_once(discord_guild):
    hook = await _hook(discord_guild)
    found = await _map(
        hook,
        "MESSAGE_DELETE_BULK",
        {"ids": [OLD, OLD, LATE], "channel_id": "211"},
    )
    assert [path for _, path in found] == [
        f"{CHANNEL_DIR}/2026-09-20/chat.jsonl",
        f"{CHANNEL_DIR}/2026-09-20/files",
        f"{CHANNEL_DIR}/2026-10-01/chat.jsonl",
        f"{CHANNEL_DIR}/2026-10-01/files",
    ]


async def test_a_reaction_updates_its_messages_day(discord_guild):
    hook = await _hook(discord_guild)
    found = await _map(
        hook,
        "MESSAGE_REACTION_ADD",
        {"message_id": OLD, "channel_id": "211", "user_id": "1"},
    )
    assert found == [(U, f"{CHANNEL_DIR}/2026-09-20/chat.jsonl")]


async def test_a_thread_message_refreshes_its_starter_in_the_parent(
    discord_guild,
):
    hook = await _hook(discord_guild)
    found = await _map(
        hook,
        "MESSAGE_CREATE",
        {
            "id": LATE,
            "channel_id": THREAD_ID,
            "attachments": [{"id": "7", "filename": "a.txt", "url": "u"}],
        },
    )
    assert found == [(U, f"{CHANNEL_DIR}/2026-09-28/chat.jsonl")]


async def test_ids_resolve_once_and_unlisted_channels_map_to_nothing(
    discord_guild,
):
    hook = await _hook(discord_guild)
    await _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "211"})
    await _map(hook, "MESSAGE_UPDATE", {"id": OLD, "channel_id": "211"})
    assert await _lookups(discord_guild) == [
        "/api/v10/channels/211",
        "/api/v10/guilds/111",
    ]
    found = await _map(
        hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": VOICE}
    )
    assert found == []


async def test_a_channel_dispatch_renames_and_lists_again(discord_guild):
    hook = await _hook(discord_guild)
    renamed = {
        "id": "211",
        "name": "lobby",
        "type": 0,
        "guild_id": "111",
    }
    found = await _map(hook, "CHANNEL_UPDATE", renamed)
    assert found == [(X, f"{GUILD_DIR}/channels")]
    found = await _map(
        hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "211"}
    )
    assert found == [
        (U, f"{GUILD_DIR}/channels/lobby__211/2026-10-01/chat.jsonl")
    ]
    assert "/api/v10/channels/211" not in await _lookups(discord_guild)


async def test_member_and_guild_dispatches_are_unknown_on_their_listing(
    discord_guild,
):
    hook = await _hook(discord_guild)
    found = await _map(
        hook, "GUILD_MEMBER_ADD", {"guild_id": "111", "user": {}}
    )
    assert found == [(X, f"{GUILD_DIR}/members")]
    assert await _map(hook, "GUILD_CREATE", {"id": "111", "name": "New"}) == [
        (X, "/d")
    ]
    assert await _map(hook, "GUILD_MEMBER_REMOVE", {"guild_id": "111"}) == [
        (X, "/d/New__111/members")
    ]


async def test_a_direct_message_and_an_unknown_dispatch_map_to_nothing(
    discord_guild,
):
    hook = await _hook(discord_guild)
    assert await _map(hook, "MESSAGE_CREATE", {"id": LATE}) == []
    assert await _map(hook, "TYPING_START", {"channel_id": "211"}) == []
    assert await _map(hook, "MESSAGE_CREATE", "not an object") == []


async def test_a_reconnect_forgets_the_guilds_channels(discord_guild):
    hook = await _hook(discord_guild)
    await _map(hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "211"})
    # general is renamed while the gateway is away; storing it reloads the
    # run, so the lookups so far are kept before it.
    before = await _lookups(discord_guild)
    await discord_guild.run.execute(
        "UPDATE DiscordChannel SET name = 'lobby' WHERE id = '211'"
    )
    await discord_guild.run.record_requests()
    await _map(hook, "GUILD_CREATE", {"id": "111", "name": "My Server"})
    found = await _map(
        hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "211"}
    )
    assert found == [
        (U, f"{GUILD_DIR}/channels/lobby__211/2026-10-01/chat.jsonl")
    ]
    lookups = [*before, *await _lookups(discord_guild)]
    assert lookups.count("/api/v10/channels/211") == 2


async def test_a_message_from_a_deleted_channel_or_guild_is_unknown_above_it(
    discord_guild,
):
    hook = await _hook(discord_guild)
    gone = {"id": OLD, "channel_id": "404", "guild_id": "111"}
    assert await _map(hook, "MESSAGE_DELETE", gone) == [
        (X, f"{GUILD_DIR}/channels")
    ]
    gone = {"id": OLD, "channel_id": "404", "guild_id": "901"}
    assert await _map(hook, "MESSAGE_DELETE", gone) == [(X, "/d")]
    found = await _map(
        hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": STRAY}
    )
    assert found == [(X, "/d")]
    found = await _map(
        hook, "MESSAGE_CREATE", {"id": LATE, "channel_id": "404"}
    )
    assert found == []
