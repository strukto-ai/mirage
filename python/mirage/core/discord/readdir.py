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
from mirage.cache.index import IndexEntry
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import (channel_entry, guild_entry,
                                       history_entry, member_entry,
                                       snowflake_to_date)
from mirage.core.discord.files import file_blob_name
from mirage.core.discord.guilds import list_guilds
from mirage.core.discord.history import list_messages_for_day
from mirage.core.discord.members import list_members
from mirage.core.discord.render import history_jsonl_bytes
from mirage.core.discord.scope import detect_scope
from mirage.core.hierarchy.readdir import DirListing, Listed, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.utils.glob_walk import glob_span, has_glob_span

logger = logging.getLogger(__name__)

SOFT_HTTP_STATUSES = frozenset((403, 404, 429))

CONTAINER_TYPE = "discord/container"


def _is_soft_error(exc: Exception) -> bool:
    return (isinstance(exc, aiohttp.ClientResponseError)
            and exc.status in SOFT_HTTP_STATUSES)


def _date_range(end_date: str,
                days: int = 30,
                span: tuple[date, date] | None = None) -> list[str]:
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
        return [(end - timedelta(days=i)).isoformat()
                for i in range(days - 1, -1, -1)]
    start = span[0]
    last = min(end, span[1] - timedelta(days=1))
    out = []
    d = start
    while d <= last:
        out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def _container_entry(name: str, guild_id: str) -> IndexEntry:
    return IndexEntry(
        id=guild_id,
        name=name,
        resource_type=CONTAINER_TYPE,
        vfs_name=name,
    )


async def _list_root(accessor: DiscordAccessor, match: ScopeMatch) -> Listed:
    guilds = await list_guilds(accessor.config, session=accessor.pool)
    entries = [guild_entry(g) for g in guilds]
    return [(entry.vfs_name, entry) for entry in entries]


async def _list_guild(accessor: DiscordAccessor, match: ScopeMatch,
                      own: IndexEntry) -> Listed:
    return [
        ("channels", _container_entry("channels", own.id)),
        ("members", _container_entry("members", own.id)),
    ]


async def _list_channels_dir(accessor: DiscordAccessor, match: ScopeMatch,
                             own: IndexEntry) -> Listed:
    channels = await list_channels(accessor.config,
                                   own.id,
                                   session=accessor.pool)
    entries = [channel_entry(c) for c in channels]
    return [(entry.vfs_name, entry) for entry in entries]


async def _list_members_dir(accessor: DiscordAccessor, match: ScopeMatch,
                            own: IndexEntry) -> Listed:
    members = await list_members(accessor.config,
                                 own.id,
                                 session=accessor.pool)
    entries = [member_entry(m) for m in members]
    return [(entry.vfs_name, entry) for entry in entries]


async def _list_channel_days(accessor: DiscordAccessor, match: ScopeMatch,
                             own: IndexEntry) -> Listed:
    last_msg_id = own.remote_time
    if last_msg_id:
        end_date = snowflake_to_date(last_msg_id)
    else:
        end_date = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    span = glob_span(match.pattern)
    entries = [(d, history_entry(own.id, d))
               for d in _date_range(end_date, span=span)]
    return DirListing(entries=entries, partial=span is not None)


async def _day_listing(accessor: DiscordAccessor, channel_id: str,
                       date_str: str) -> DirListing:
    """One history fetch, answering the day dir and its files subdir.

    A soft HTTP error (403/404/429) seals an empty day: the dir lists
    nothing, and stat serves chat.jsonl with the size left unknown.

    Args:
        accessor (DiscordAccessor): discord accessor.
        channel_id (str): the channel snowflake.
        date_str (str): the day, ``YYYY-MM-DD``.
    """
    try:
        messages = await list_messages_for_day(accessor.config,
                                               channel_id,
                                               date_str,
                                               session=accessor.pool)
    except aiohttp.ClientResponseError as e:
        if _is_soft_error(e):
            logger.debug("discord: history denied for %s/%s (%d); empty day",
                         channel_id, date_str, e.status)
            return DirListing(entries=[])
        raise
    # The day's messages are already in hand, so chat.jsonl's exact rendered
    # size is free here; read() renders the same messages the same way.
    chat_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:chat",
        name="chat.jsonl",
        resource_type="discord/chat_jsonl",
        vfs_name="chat.jsonl",
        size=len(history_jsonl_bytes(messages)),
    )
    files_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:files",
        name="files",
        resource_type="discord/files_dir",
        vfs_name="files",
        extra={
            "channel_id": channel_id,
            "date": date_str
        },
    )
    file_entries: list[tuple[str, IndexEntry]] = []
    for msg in messages:
        for att in msg.get("attachments") or []:
            # Tombstoned (deleted) and access-restricted attachment payloads
            # carry an id but no download URL and no byte size; read()
            # ENOENTs on them, so listing them would surface phantom files
            # with unknown sizes. Mirrors the slack guard.
            if (not att.get("id") or not att.get("url")
                    or att.get("size") is None):
                continue
            blob_name = file_blob_name(att)
            file_entries.append((blob_name,
                                 IndexEntry(
                                     id=str(att["id"]),
                                     name=att.get("filename") or "",
                                     resource_type="discord/file",
                                     vfs_name=blob_name,
                                     size=att.get("size"),
                                     extra={
                                         "url":
                                         att.get("url", ""),
                                         "proxy_url":
                                         att.get("proxy_url", ""),
                                         "content_type":
                                         att.get("content_type", ""),
                                         "message_id":
                                         msg.get("id", ""),
                                         "author":
                                         msg.get("author",
                                                 {}).get("username", ""),
                                         "channel_id":
                                         channel_id,
                                         "date":
                                         date_str,
                                     },
                                 )))
    return DirListing(
        entries=[("chat.jsonl", chat_entry), ("files", files_entry)],
        seeds={"files": file_entries},
    )


async def _list_day(accessor: DiscordAccessor, match: ScopeMatch,
                    channel: IndexEntry) -> Listed:
    # The proof is the channel entry, not the day's own: any well-formed
    # date under a real channel fetches, including dates outside the
    # bounded window the channel listing mints.
    return await _day_listing(accessor, channel.id, match.slots["day"])


async def _list_files(accessor: DiscordAccessor, match: ScopeMatch,
                      own: IndexEntry) -> Listed:
    # Normally served from the day lister's seed; reached only when the
    # index evicted the files listing while the day's entries survived.
    channel_id = own.extra.get("channel_id") or own.id.split(":", 1)[0]
    listing = await _day_listing(accessor, channel_id, match.slots["day"])
    return listing.seeds.get("files", [])


readdir = make_readdir(
    detect_scope,
    listers={"root": _list_root},
    entry_listers={
        "guild": _list_guild,
        "channels_dir": _list_channels_dir,
        "members_dir": _list_members_dir,
        "channel": _list_channel_days,
        "files": _list_files,
    },
    parent_entry_listers={"day": _list_day},
    pattern_kinds={"channel": has_glob_span},
    leaf_error="enotdir",
)
