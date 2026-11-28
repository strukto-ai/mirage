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

import pytest

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.entry import snowflake_to_iso
from mirage.core.render.json import jsonl_bytes
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.discord import DiscordVFS
from tests.fixtures.discord_guild import (
    DAY,
    GENERAL,
    GUILD,
    GUILD_DIR,
    MESSAGES,
)
from tests.fixtures.mounted import mounted

pytestmark = pytest.mark.asyncio

CHANNEL = f"{GUILD_DIR}/channels/general__211"
REFUSED_DAY = "2024-01-13"


async def stat(accessor: DiscordAccessor, path: PathSpec) -> FileStat:
    return await mounted(DiscordVFS, accessor).stat(path)


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def test_stat_root(accessor):
    row = await stat(accessor, spec("/"))
    assert row.type is FileType.DIRECTORY


async def test_stat_guild(accessor):
    row = await stat(accessor, spec(f"/{GUILD_DIR}"))
    assert row.type is FileType.DIRECTORY
    assert row.name == GUILD_DIR
    assert row.extra["guild_id"] == GUILD


async def test_stat_bogus_guild_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/Nope__9"))


async def test_stat_containers(accessor):
    for name in ("channels", "members"):
        row = await stat(accessor, spec(f"/{GUILD_DIR}/{name}"))
        assert row.type is FileType.DIRECTORY
        assert row.name == name


async def test_stat_container_under_bogus_guild_is_enoent(accessor):
    # The containers exist per guild, so a guild the listing does not
    # prove takes its children with it.
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec("/Nope__9/channels"))


async def test_stat_channel(discord_guild, accessor):
    row = await stat(accessor, spec(f"/{CHANNEL}"))
    assert row.type is FileType.DIRECTORY
    assert row.extra["channel_id"] == GENERAL
    # A channel is dated by its last message.
    listed = await discord_guild.channel(GENERAL)
    assert row.modified == snowflake_to_iso(listed["last_message_id"])


async def test_stat_member(accessor):
    row = await stat(accessor, spec(f"/{GUILD_DIR}/members/alice__311.json"))
    assert row.content is ContentType.JSON
    assert row.extra["user_id"] == "311"
    assert row.size is not None and row.size > 0


async def test_stat_day_dir(accessor):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}"))
    assert row.type is FileType.DIRECTORY
    assert row.name == DAY


async def test_stat_day_outside_the_window_is_a_directory(accessor):
    # The channel listing synthesizes a bounded window of recent days, but
    # the history API answers a range query for any date.
    row = await stat(accessor, spec(f"/{CHANNEL}/1999-01-01"))
    assert row.type is FileType.DIRECTORY
    assert row.name == "1999-01-01"


async def test_stat_day_under_bogus_channel_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec(f"/{GUILD_DIR}/channels/nope__9/{DAY}"))


async def test_stat_chat_jsonl(discord_guild, accessor):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/chat.jsonl"))
    assert row.content is ContentType.TEXT
    assert row.size == len(jsonl_bytes(await discord_guild.day(GENERAL, DAY)))


async def test_stat_chat_jsonl_in_a_refused_day_is_eacces(
    discord_guild, accessor
):
    await discord_guild.refuse(MESSAGES, 403)
    with pytest.raises(PermissionError):
        await stat(accessor, spec(f"/{CHANNEL}/{REFUSED_DAY}/chat.jsonl"))


async def test_stat_chat_jsonl_under_bogus_channel_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            spec(f"/{GUILD_DIR}/channels/nope__9/{DAY}/chat.jsonl"),
        )


async def test_stat_files_dir(accessor):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/files"))
    assert row.type is FileType.DIRECTORY


async def test_stat_files_under_a_refused_day_is_eacces(
    discord_guild, accessor
):
    await discord_guild.refuse(MESSAGES, 403)
    with pytest.raises(PermissionError):
        await stat(accessor, spec(f"/{CHANNEL}/{REFUSED_DAY}/files"))


async def test_stat_file_blob(accessor):
    row = await stat(accessor, spec(f"/{CHANNEL}/{DAY}/files/kept__A1.txt"))
    assert row.size == len(b"0123456789")
    assert row.extra["attachment_id"] == "A1"
    assert row.extra["content_type"] == "text/plain"


async def test_stat_unknown_shape_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, spec(f"/{GUILD_DIR}/nope"))
