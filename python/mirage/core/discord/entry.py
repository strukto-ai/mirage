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
from typing import Any

from mirage.core.discord.history import DISCORD_EPOCH
from mirage.core.render.json import compact_json_bytes
from mirage.types import ContentType, FileStat, FileType
from mirage.utils.dates import epoch_to_iso
from mirage.utils.naming import make_id_name


def guild_dirname(g: dict[str, Any]) -> str:
    return make_id_name(g.get("name", ""), g["id"], path_safe=True)


def channel_dirname(c: dict[str, Any]) -> str:
    return make_id_name(c.get("name", ""), c["id"], path_safe=True)


def member_filename(m: dict[str, Any]) -> str:
    user = m.get("user", {})
    return make_id_name(
        user.get("username", ""), user["id"], path_safe=True, suffix=".json"
    )


def snowflake_to_date(snowflake: str) -> str:
    """Convert a Discord snowflake to a UTC YYYY-MM-DD date string."""
    ms = (int(snowflake) >> 22) + DISCORD_EPOCH
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d"
    )


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


def guild_entry(g: dict[str, Any]) -> FileStat:
    return FileStat(
        name=guild_dirname(g),
        type=FileType.DIRECTORY,
        extra={"guild_id": g["id"]},
    )


def channel_entry(c: dict[str, Any]) -> FileStat:
    last = c.get("last_message_id", "") or ""
    return FileStat(
        name=channel_dirname(c),
        type=FileType.DIRECTORY,
        modified=snowflake_to_iso(last),
        extra={"channel_id": c["id"], "last_message_id": last},
    )


def member_entry(m: dict[str, Any]) -> FileStat:
    user = m.get("user", {})
    return FileStat(
        name=member_filename(m),
        type=FileType.FILE,
        content=ContentType.JSON,
        size=len(compact_json_bytes(m)),
        extra={"user_id": user.get("id", "")},
    )


def history_entry(channel_id: str, date: str) -> FileStat:
    # channel_id rides extra so the day and files listers can query the
    # history API without re-resolving the channel through its parent.
    return FileStat(
        name=date, type=FileType.DIRECTORY, extra={"channel_id": channel_id}
    )
