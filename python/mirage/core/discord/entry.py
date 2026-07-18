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
from enum import Enum
from typing import Any

from mirage.cache.index.config import IndexEntry
from mirage.core.discord.history import DISCORD_EPOCH
from mirage.core.timeutil import epoch_to_iso
from mirage.utils.naming import make_id_name


class DiscordResourceType(str, Enum):
    GUILD = "discord/guild"
    CHANNEL = "discord/channel"
    MEMBER = "discord/member"
    HISTORY = "discord/history"


def guild_dirname(g: dict[str, Any]) -> str:
    return make_id_name(g.get("name", ""), g["id"], path_safe=True)


def channel_dirname(c: dict[str, Any]) -> str:
    return make_id_name(c.get("name", ""), c["id"], path_safe=True)


def member_filename(m: dict[str, Any]) -> str:
    user = m.get("user", {})
    return (
        f"{make_id_name(user.get('username', ''), user['id'], path_safe=True)}"
        ".json")


def snowflake_to_date(snowflake: str) -> str:
    """Convert a Discord snowflake to a UTC YYYY-MM-DD date string."""
    ms = (int(snowflake) >> 22) + DISCORD_EPOCH
    return datetime.fromtimestamp(ms / 1000,
                                  tz=timezone.utc).strftime("%Y-%m-%d")


def snowflake_to_iso(snowflake: str) -> str | None:
    """Convert a Discord snowflake to a UTC ISO-8601 timestamp (second
    precision, matching the TypeScript converter).

    Args:
        snowflake (str): the Discord snowflake id (empty/invalid -> None).
    """
    if not snowflake:
        return None
    try:
        ms = (int(snowflake) >> 22) + DISCORD_EPOCH
    except (TypeError, ValueError):
        return None
    return epoch_to_iso(ms // 1000)


def guild_entry(g: dict[str, Any]) -> IndexEntry:
    return IndexEntry(
        id=g["id"],
        name=g.get("name", ""),
        resource_type=DiscordResourceType.GUILD,
        vfs_name=guild_dirname(g),
    )


def channel_entry(c: dict[str, Any]) -> IndexEntry:
    return IndexEntry(
        id=c["id"],
        name=c.get("name", ""),
        resource_type=DiscordResourceType.CHANNEL,
        vfs_name=channel_dirname(c),
        remote_time=c.get("last_message_id", "") or "",
    )


def member_entry(m: dict[str, Any]) -> IndexEntry:
    user = m.get("user", {})
    return IndexEntry(
        id=user.get("id", ""),
        name=user.get("username", ""),
        resource_type=DiscordResourceType.MEMBER,
        vfs_name=member_filename(m),
    )


def history_entry(channel_key: str, date: str) -> IndexEntry:
    return IndexEntry(
        id=f"{channel_key}:{date}",
        name=date,
        resource_type=DiscordResourceType.HISTORY,
        vfs_name=f"{date}.jsonl",
    )
