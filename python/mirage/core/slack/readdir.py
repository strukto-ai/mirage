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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry
from mirage.core.api.client import SessionArg
from mirage.core.hierarchy.readdir import DirListing, Listed, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.slack.channels import list_channels, list_dms
from mirage.core.slack.client import slack_get
from mirage.core.slack.files import file_blob_name
from mirage.core.slack.formatters import (channel_dirname, dm_dirname,
                                          user_filename)
from mirage.core.slack.history import fetch_messages_for_day, messages_to_jsonl
from mirage.core.slack.scope import detect_scope
from mirage.core.slack.users import list_users, user_json_bytes
from mirage.utils.glob_walk import glob_span, has_glob_span

logger = logging.getLogger(__name__)

VIRTUAL_ROOTS = ("channels", "dms", "users")

_SOFT_HISTORY_ERRORS = (
    "not_in_channel",
    "channel_not_found",
    "missing_scope",
    "is_archived",
    "not_authed",
)


def _date_range(latest_ts: float,
                created: int,
                max_days: int = 90,
                span: tuple[date, date] | None = None) -> list[str]:
    """The channel's day directories, newest first.

    A day dir is real for any date the channel has existed for, so the
    bare listing is a window: the last ``max_days`` up to the newest
    message. A glob names its own window instead, and then the cap does
    not apply, because the span is already bounded by what was typed.

    Args:
        latest_ts (float): timestamp of the newest message.
        created (int): channel creation timestamp.
        max_days (int): how many days the bare window covers.
        span (tuple[date, date] | None): the glob's half-open range.
    """
    end = datetime.fromtimestamp(latest_ts, tz=timezone.utc).date()
    start = datetime.fromtimestamp(created, tz=timezone.utc).date()
    if span is not None:
        start = max(start, span[0])
        end = min(end, span[1] - timedelta(days=1))
    elif (end - start).days > max_days:
        start = end - timedelta(days=max_days - 1)
    dates = []
    d = end
    while d >= start:
        dates.append(d.isoformat())
        d -= timedelta(days=1)
    return dates


async def _latest_message_ts(config,
                             channel_id: str,
                             session: SessionArg = None) -> float | None:
    try:
        data = await slack_get(config,
                               "conversations.history",
                               params={
                                   "channel": channel_id,
                                   "limit": 1,
                               },
                               session=session)
    except RuntimeError as e:
        if any(code in str(e) for code in _SOFT_HISTORY_ERRORS):
            logger.debug(
                "slack: history denied for %s (%s); treating as empty",
                channel_id, e)
            return None
        raise
    messages = data.get("messages", [])
    if messages:
        return float(messages[0].get("ts", "0"))
    return None


async def _list_channels_root(accessor: SlackAccessor,
                              match: ScopeMatch) -> Listed:
    channels = await list_channels(accessor.config, session=accessor.pool)
    entries: list[tuple[str, IndexEntry]] = []
    for ch in channels:
        dirname = channel_dirname(ch)
        entries.append((dirname,
                        IndexEntry(
                            id=ch["id"],
                            name=ch.get("name", ""),
                            resource_type="slack/channel",
                            vfs_name=dirname,
                            remote_time=str(ch.get("created", 0)),
                        )))
    return entries


async def _list_dms_root(accessor: SlackAccessor, match: ScopeMatch) -> Listed:
    dms = await list_dms(accessor.config, session=accessor.pool)
    users = await list_users(accessor.config, session=accessor.pool)
    user_map = {u["id"]: u.get("name", u["id"]) for u in users}
    entries: list[tuple[str, IndexEntry]] = []
    for dm in dms:
        dirname = dm_dirname(dm, user_map)
        uid = dm.get("user", "")
        entries.append((dirname,
                        IndexEntry(
                            id=dm["id"],
                            name=user_map.get(uid, uid),
                            resource_type="slack/dm",
                            vfs_name=dirname,
                            remote_time=str(dm.get("created", 0)),
                        )))
    return entries


async def _list_users_root(accessor: SlackAccessor,
                           match: ScopeMatch) -> Listed:
    users = await list_users(accessor.config, session=accessor.pool)
    entries: list[tuple[str, IndexEntry]] = []
    for u in users:
        filename = user_filename(u)
        entries.append((filename,
                        IndexEntry(
                            id=u["id"],
                            name=u.get("name", ""),
                            resource_type="slack/user",
                            vfs_name=filename,
                            size=len(user_json_bytes(u)),
                        )))
    return entries


async def _list_channel_days(accessor: SlackAccessor, match: ScopeMatch,
                             own: IndexEntry) -> Listed:
    created = int(own.remote_time or 0)
    span = glob_span(match.pattern)
    latest_ts = await _latest_message_ts(accessor.config,
                                         own.id,
                                         session=accessor.pool)
    if latest_ts and created:
        dates = _date_range(latest_ts, created, span=span)
    elif latest_ts:
        dates = _date_range(latest_ts, int(latest_ts), span=span)
    else:
        dates = []
    entries = [(d,
                IndexEntry(
                    id=f"{own.id}:{d}",
                    name=d,
                    resource_type="slack/date_dir",
                    vfs_name=d,
                    extra={"channel_id": own.id},
                )) for d in dates]
    return DirListing(entries=entries, partial=span is not None)


async def _day_listing(accessor: SlackAccessor, channel_id: str,
                       date_str: str) -> DirListing:
    """One history fetch, answering the day dir and its files subdir.

    A soft history error (not_in_channel, missing_scope, ...) seals an
    empty day: the dir lists nothing, and stat serves chat.jsonl with
    the size left unknown.

    Args:
        accessor (SlackAccessor): slack accessor.
        channel_id (str): the channel or DM id.
        date_str (str): the day, ``YYYY-MM-DD``.
    """
    try:
        messages = await fetch_messages_for_day(accessor.config,
                                                channel_id,
                                                date_str,
                                                session=accessor.pool)
    except RuntimeError as e:
        if any(code in str(e) for code in _SOFT_HISTORY_ERRORS):
            logger.debug("slack: history denied for %s/%s (%s); empty day",
                         channel_id, date_str, e)
            return DirListing(entries=[])
        raise
    chat_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:chat",
        name="chat.jsonl",
        resource_type="slack/chat_jsonl",
        vfs_name="chat.jsonl",
        size=len(messages_to_jsonl(messages)),
    )
    files_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:files",
        name="files",
        resource_type="slack/files_dir",
        vfs_name="files",
        extra={
            "channel_id": channel_id,
            "date": date_str
        },
    )
    file_entries: list[tuple[str, IndexEntry]] = []
    for msg in messages:
        for fmeta in msg.get("files", []) or []:
            # Tombstoned (deleted) and access-restricted file payloads carry
            # an id but no download URL and no byte size; read() ENOENTs on
            # them, so listing them would both surface phantom files and
            # break the SIZES_ALWAYS_KNOWN contract.
            if (not fmeta.get("id") or not fmeta.get("url_private_download")
                    or fmeta.get("size") is None):
                continue
            blob_name = file_blob_name(fmeta)
            file_entries.append(
                (blob_name,
                 IndexEntry(
                     id=fmeta["id"],
                     name=fmeta.get("title") or fmeta.get("name") or "",
                     resource_type="slack/file",
                     vfs_name=blob_name,
                     size=fmeta["size"],
                     remote_time=str(fmeta.get("timestamp", "")),
                     extra={
                         "mimetype":
                         fmeta.get("mimetype", ""),
                         "url_private_download":
                         fmeta.get("url_private_download", ""),
                         "filetype":
                         fmeta.get("filetype", ""),
                         "ts":
                         msg.get("ts", ""),
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


async def _list_day(accessor: SlackAccessor, match: ScopeMatch,
                    channel: IndexEntry) -> Listed:
    # The proof is the channel entry, not the day's own: any well-formed
    # date under a real channel fetches, including dates outside the
    # bounded window the channel listing mints.
    return await _day_listing(accessor, channel.id, match.slots["day"])


async def _list_files(accessor: SlackAccessor, match: ScopeMatch,
                      own: IndexEntry) -> Listed:
    # Normally served from the day lister's seed; reached only when the
    # index evicted the files listing while the day's entries survived.
    channel_id = own.extra.get("channel_id") or own.id.split(":", 1)[0]
    listing = await _day_listing(accessor, channel_id, match.slots["day"])
    return listing.seeds.get("files", [])


readdir = make_readdir(
    detect_scope,
    listers={
        "channels_root": _list_channels_root,
        "dms_root": _list_dms_root,
        "users_root": _list_users_root,
    },
    entry_listers={
        "channel": _list_channel_days,
        "files": _list_files,
    },
    parent_entry_listers={"day": _list_day},
    static_root=VIRTUAL_ROOTS,
    pattern_kinds={"channel": has_glob_span},
)

__all__ = ["readdir", "VIRTUAL_ROOTS"]
