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

import logging
from datetime import date, datetime, timedelta, timezone

import aiohttp

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import (
    channel_entry,
    guild_entry,
    history_entry,
    member_entry,
    snowflake_to_date,
)
from mirage.core.discord.files import file_blob_name, is_listed
from mirage.core.discord.guilds import list_guilds
from mirage.core.discord.history import list_messages_for_day
from mirage.core.discord.members import list_members
from mirage.core.discord.scope import detect_scope
from mirage.core.hierarchy.readdir import Listed, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import jsonl_bytes
from mirage.core.time_range import guard_day
from mirage.types import ContentType, DirListing, FileStat, FileType
from mirage.utils.filetype import content_type_for_mime
from mirage.utils.glob_walk import glob_span, has_glob_span

logger = logging.getLogger(__name__)

SOFT_HTTP_STATUSES = frozenset((403, 404, 429))


def _is_soft_error(exc: Exception) -> bool:
    return (
        isinstance(exc, aiohttp.ClientResponseError)
        and exc.status in SOFT_HTTP_STATUSES
    )


def _date_range(
    end_date: str, days: int = 30, span: tuple[date, date] | None = None
) -> list[str]:
    """The channel's day directories, oldest first.

    A day dir is real for any well-formed date under the channel, so the
    bare listing is a window: the last ``days`` up to the newest
    message. A glob names its own window instead, clipped at the newest
    message because nothing was posted after it.

    Args:
        end_date (str): the newest message's date, ``YYYY-MM-DD``.
        days (int): how many days the bare window covers.
        span (tuple[date, date] | None): the glob's half-open range.
    """
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    if span is None:
        return [
            (end - timedelta(days=i)).isoformat()
            for i in range(days - 1, -1, -1)
        ]
    start = span[0]
    last = min(end, span[1] - timedelta(days=1))
    out = []
    d = start
    while d <= last:
        out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _container_entry(name: str, guild_id: str) -> FileStat:
    return FileStat(
        name=name, type=FileType.DIRECTORY, extra={"guild_id": guild_id}
    )


async def _list_root(accessor: DiscordAccessor, match: ScopeMatch) -> Listed:
    guilds = await list_guilds(accessor.config, session=accessor.pool)
    return [guild_entry(g) for g in guilds]


async def _list_guild(
    accessor: DiscordAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    guild_id = str(own.extra["guild_id"])
    return [
        _container_entry("channels", guild_id),
        _container_entry("members", guild_id),
    ]


async def _list_channels_dir(
    accessor: DiscordAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    channels = await list_channels(
        accessor.config, str(own.extra["guild_id"]), session=accessor.pool
    )
    return [channel_entry(c) for c in channels]


async def _list_members_dir(
    accessor: DiscordAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    members = await list_members(
        accessor.config, str(own.extra["guild_id"]), session=accessor.pool
    )
    return [member_entry(m) for m in members]


async def _list_channel_days(
    accessor: DiscordAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    channel_id = str(own.extra["channel_id"])
    last_msg_id = str(own.extra.get("last_message_id") or "")
    if last_msg_id:
        end_date = snowflake_to_date(last_msg_id)
    else:
        end_date = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    span = glob_span(match.pattern)
    dates = (
        accessor.time_range.listing_days(
            date.fromisoformat(snowflake_to_date(channel_id)),
            date.fromisoformat(end_date),
            span,
        )
        if accessor.time_range.bounded
        else _date_range(end_date, span=span)
    )
    return DirListing(
        entries=[history_entry(channel_id, d) for d in dates],
        partial=span is not None,
        window=True,
    )


async def _day_listing(
    accessor: DiscordAccessor, channel_id: str, date_str: str
) -> DirListing:
    """One history fetch, answering the day dir and its files subdir.

    A soft HTTP error (403/404/429) seals an empty day: the dir lists
    nothing, and stat serves chat.jsonl with the size left unknown.

    Args:
        accessor (DiscordAccessor): discord accessor.
        channel_id (str): the channel snowflake.
        date_str (str): the day, ``YYYY-MM-DD``.
    """
    try:
        messages = await list_messages_for_day(
            accessor.config,
            channel_id,
            date_str,
            accessor.time_range,
            session=accessor.pool,
        )
    except aiohttp.ClientResponseError as e:
        if _is_soft_error(e):
            logger.debug(
                "discord: history denied for %s/%s (%d); empty day",
                channel_id,
                date_str,
                e.status,
            )
            # A soft error is not the channel saying the day's messages
            # are gone, so the empty day must not evict what it held.
            return DirListing(entries=[], window=True)
        raise
    # The day's messages are already in hand, so chat.jsonl's exact rendered
    # size is free here; read() renders the same messages the same way.
    blobs: list[FileStat] = []
    for msg in messages:
        for att in msg.get("attachments") or []:
            if not is_listed(att):
                continue
            mimetype = att.get("content_type", "")
            blobs.append(
                FileStat(
                    name=file_blob_name(att),
                    type=FileType.FILE,
                    content=content_type_for_mime(mimetype),
                    size=att.get("size"),
                    extra={
                        "attachment_id": str(att["id"]),
                        "content_type": mimetype,
                        "url": att.get("url", ""),
                        "proxy_url": att.get("proxy_url", ""),
                        "message_id": msg.get("id", ""),
                        "author": msg.get("author", {}).get("username", ""),
                        "channel_id": channel_id,
                        "date": date_str,
                    },
                )
            )
    return DirListing(
        entries=[
            FileStat(
                name="chat.jsonl",
                type=FileType.FILE,
                content=ContentType.TEXT,
                size=len(jsonl_bytes(messages)),
                extra={"channel_id": channel_id},
            ),
            FileStat(
                name="files",
                type=FileType.DIRECTORY,
                extra={"channel_id": channel_id, "date": date_str},
            ),
        ],
        seeds={"files": blobs},
    )


async def _list_day(
    accessor: DiscordAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    # The day's row carries its channel: one the bounded window lists, or
    # one stat makes for any well-formed date under a real channel, so a
    # date outside the window fetches too.
    return await _day_listing(
        accessor, str(own.extra["channel_id"]), match.slots["day"]
    )


async def _list_files(
    accessor: DiscordAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    # Normally served from the day lister's seed; reached only when the
    # index evicted the files listing while the day's rows survived.
    listing = await _day_listing(
        accessor, str(own.extra["channel_id"]), match.slots["day"]
    )
    # A soft-error day proves nothing about its attachments either.
    return DirListing(
        entries=list(listing.seeds.get("files", [])), window=listing.window
    )


readdir = make_readdir(
    detect_scope,
    listers={"root": _list_root},
    entry_listers={
        "guild": _list_guild,
        "channels_dir": _list_channels_dir,
        "members_dir": _list_members_dir,
        "channel": _list_channel_days,
        "day": _list_day,
        "files": _list_files,
    },
    guards={"day": guard_day, "files": guard_day},
    pattern_kinds={"channel": has_glob_span},
    leaf_error="enotdir",
)
