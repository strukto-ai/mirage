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

import re
from datetime import datetime, timezone
from urllib.parse import urlencode

import pytest

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.history import snowflake_at
from mirage.core.render.json import compact_json_bytes, jsonl_bytes
from mirage.types import FileStat, PathSpec
from mirage.vfs.discord import DiscordVFS
from tests.fixtures.discord_guild import (
    ALICE,
    DAY,
    GENERAL,
    GUILD,
    GUILD_DIR,
    MESSAGES,
)
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio

CHANNEL = f"{GUILD_DIR}/channels/general__211"


async def readdir(accessor: DiscordAccessor, path: PathSpec) -> list[str]:
    return await mounted(DiscordVFS, accessor).readdir(path)


async def stat(accessor: DiscordAccessor, path: PathSpec) -> FileStat:
    return await mounted(DiscordVFS, accessor).stat(path)


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def _named(discord_guild, name: str) -> None:
    # A guild's name is the server owner's to set; the run is reloaded
    # with it, which no request the bot makes can do.
    await discord_guild.run.execute(
        "UPDATE DiscordGuild SET name = ? WHERE id = ?", name, GUILD
    )


async def test_readdir_root(accessor):
    result = await readdir(accessor, spec("/"))
    assert result == [f"/{GUILD_DIR}"]


async def test_readdir_root_with_slash_in_name(discord_guild, accessor):
    await _named(discord_guild, "A/B Test Server")
    result = await readdir(accessor, spec("/"))
    assert result == [f"/A∕B Test Server__{GUILD}"]


async def test_readdir_root_with_apostrophe(discord_guild, accessor):
    await _named(discord_guild, "Zecheng's Server")
    result = await readdir(accessor, spec("/"))
    assert result == [f"/Zecheng's Server__{GUILD}"]


async def test_readdir_guild(accessor):
    result = await readdir(accessor, spec(f"/{GUILD_DIR}"))
    assert result == [
        f"/{GUILD_DIR}/channels",
        f"/{GUILD_DIR}/members",
    ]


async def test_readdir_bogus_guild_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("/Nope__9"))


async def test_readdir_channels(accessor):
    result = await readdir(accessor, spec(f"/{GUILD_DIR}/channels"))
    assert result == [
        f"/{GUILD_DIR}/channels/general__211",
        f"/{GUILD_DIR}/channels/random__212",
    ]


async def test_readdir_channel_dates(accessor):
    result = await readdir(accessor, spec(f"/{CHANNEL}"))
    assert len(result) >= 1
    date_re = re.compile(rf"^/{re.escape(CHANNEL)}/\d{{4}}-\d{{2}}-\d{{2}}$")
    assert all(date_re.match(r) for r in result)
    assert f"/{CHANNEL}/{DAY}" in result


async def test_readdir_date_sizes_chat_jsonl(discord_guild, accessor):
    await readdir(accessor, spec(f"/{CHANNEL}/{DAY}"))
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/chat.jsonl"))
    assert row.size == len(jsonl_bytes(await discord_guild.day(GENERAL, DAY)))


async def test_readdir_members_sized(discord_guild, accessor):
    await readdir(accessor, spec(f"/{GUILD_DIR}/members"))
    row = await stat(accessor, spec(f"/{GUILD_DIR}/members/alice__311.json"))
    assert row.size == len(
        compact_json_bytes(await discord_guild.member(ALICE))
    )


async def test_readdir_unknown_shape_raises_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec(f"/{GUILD_DIR}/nope"))


async def test_readdir_leaf_raises_enotdir(accessor):
    # A file is ENOTDIR, not ENOENT: callers tell "read this" from "nothing
    # here" by the errno.
    with pytest.raises(NotADirectoryError):
        await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/chat.jsonl"))


async def test_readdir_files_skips_tombstoned_attachments(
    discord_guild, accessor
):
    # Tombstoned and access-restricted attachments carry an id but no
    # download URL and no byte size; listing them would surface phantom
    # files that ENOENT on read. The fake stores the tombstone; Discord's
    # own day, one attachment with no size and one with no URL added.
    eve = (
        snowflake_at(datetime(2024, 1, 15, tzinfo=timezone.utc).timestamp())
        - 1
    )
    query = urlencode({"after": str(eve), "limit": "100"})
    page = await discord_guild.run.call(
        "GET", f"/api/v10/channels/{GENERAL}/messages?{query}"
    )
    files = next(m for m in page if m["content"] == "files")
    kept = files["attachments"][0]
    files["attachments"] += [
        {"id": "A3", "filename": "sizeless.txt", "url": kept["url"]},
        {"id": "A4", "filename": "urlless.txt", "size": 9},
    ]
    await discord_guild.run.answer_next("GET", MESSAGES, 200, page)
    names = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/files"))
    assert names == [f"/{CHANNEL}/{DAY}/files/kept__A1.txt"]


async def test_files_dir_rides_the_day_fetch(discord_guild, accessor):
    # One history fetch answers the day dir AND its files subdir: the day
    # lister seeds the files listing, so entering it costs no second call.
    await readdir(accessor, spec(f"/{CHANNEL}/{DAY}"))
    fetches = len(await discord_guild.day_fetches())
    names = await readdir(accessor, spec(f"/{CHANNEL}/{DAY}/files"))
    assert names == [f"/{CHANNEL}/{DAY}/files/kept__A1.txt"]
    assert len(await discord_guild.day_fetches()) == fetches
