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
from typing import Any

from mirage.accessor.slack import SlackAccessor
from mirage.core.hierarchy.readdir import Listed, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import jsonl_bytes
from mirage.core.slack.channels import list_channels, list_dms
from mirage.core.slack.client import slack_get
from mirage.core.slack.formatters import (
    channel_dirname,
    dm_dirname,
    file_blob_name,
    user_filename,
)
from mirage.core.slack.history import fetch_messages_for_day
from mirage.core.slack.paginate import cursor_pages
from mirage.core.slack.scope import detect_scope
from mirage.core.slack.users import list_users, user_json_bytes
from mirage.core.time_range import guard_day
from mirage.types import ContentType, DirListing, FileStat, FileType
from mirage.utils.dates import epoch_to_iso
from mirage.utils.filetype import content_type_for_mime
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


def _date_range(
    latest_ts: float,
    created: int,
    max_days: int = 90,
    span: tuple[date, date] | None = None,
) -> list[str]:
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


async def _latest_message_ts(
    accessor: SlackAccessor, channel_id: str
) -> float | None:
    try:
        data = await slack_get(
            accessor,
            "conversations.history",
            params={"channel": channel_id, "limit": 1},
        )
    except RuntimeError as e:
        if any(code in str(e) for code in _SOFT_HISTORY_ERRORS):
            logger.debug(
                "slack: history denied for %s (%s); treating as empty",
                channel_id,
                e,
            )
            return None
        raise
    messages = data.get("messages", [])
    if messages:
        return float(messages[0].get("ts", "0"))
    return None


async def _earliest_message_ts(
    accessor: SlackAccessor, channel_id: str, latest: float
) -> float:
    """Discover the history start when conversation metadata omits creation.

    Only history before the scope's end is paged: a message after it is
    out of scope, and the first message overall precedes the end whenever
    anything in scope exists at all.

    Args:
        accessor (SlackAccessor): scoped accessor.
        channel_id (str): conversation id.
        latest (float): newest known message timestamp.
    """
    params: dict[str, str | int] = {"channel": channel_id, "limit": 200}
    if accessor.time_range.end is not None:
        params["latest"] = f"{accessor.time_range.end:.6f}"
    first = latest
    async for page in cursor_pages(
        accessor, "conversations.history", params, "messages"
    ):
        for message in page:
            first = min(first, float(message["ts"]))
    return first


def _slack_modified(remote_time: str | int | float | None) -> str | None:
    if not remote_time:
        return None
    try:
        ts = float(remote_time)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return epoch_to_iso(ts)


def _conversation(
    dirname: str, conversation: dict[str, Any], name: str
) -> FileStat:
    created = int(conversation.get("created", 0) or 0)
    return FileStat(
        name=dirname,
        type=FileType.DIRECTORY,
        modified=_slack_modified(created),
        extra={
            "channel_id": conversation["id"],
            "name": name,
            "created": created,
        },
    )


async def _list_channels_root(
    accessor: SlackAccessor, match: ScopeMatch
) -> Listed:
    channels = await list_channels(accessor)
    return [
        _conversation(channel_dirname(ch), ch, ch.get("name", ""))
        for ch in channels
    ]


async def _list_dms_root(accessor: SlackAccessor, match: ScopeMatch) -> Listed:
    dms = await list_dms(accessor)
    users = await list_users(accessor)
    user_map = {u["id"]: u.get("name", u["id"]) for u in users}
    return [
        _conversation(
            dm_dirname(dm, user_map),
            dm,
            user_map.get(dm.get("user", ""), dm.get("user", "")),
        )
        for dm in dms
    ]


async def _list_users_root(
    accessor: SlackAccessor, match: ScopeMatch
) -> Listed:
    users = await list_users(accessor)
    return [
        FileStat(
            name=user_filename(u),
            type=FileType.FILE,
            content=ContentType.JSON,
            size=len(user_json_bytes(u)),
            extra={"user_id": u["id"]},
        )
        for u in users
    ]


async def _list_channel_days(
    accessor: SlackAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    channel_id = str(own.extra["channel_id"])
    created = int(own.extra.get("created") or 0)
    span = glob_span(match.pattern)
    latest_ts = await _latest_message_ts(accessor, channel_id)
    if latest_ts and accessor.time_range.bounded:
        start = created or accessor.time_range.start
        if start is not None:
            first = datetime.fromtimestamp(start, timezone.utc).date()
        elif span is not None:
            first = span[0]
        else:
            first = datetime.fromtimestamp(
                await _earliest_message_ts(accessor, channel_id, latest_ts),
                timezone.utc,
            ).date()
        dates = list(
            reversed(
                accessor.time_range.listing_days(
                    first,
                    datetime.fromtimestamp(latest_ts, timezone.utc).date(),
                    span,
                )
            )
        )
    elif latest_ts and created:
        dates = _date_range(latest_ts, created, span=span)
    elif latest_ts:
        dates = _date_range(latest_ts, int(latest_ts), span=span)
    else:
        dates = []
    rows = [
        FileStat(
            name=d, type=FileType.DIRECTORY, extra={"channel_id": channel_id}
        )
        for d in dates
    ]
    return DirListing(entries=rows, partial=span is not None, window=True)


async def _day_listing(
    accessor: SlackAccessor, channel_id: str, date_str: str
) -> DirListing:
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
        messages = await fetch_messages_for_day(
            accessor, channel_id, date_str, accessor.time_range
        )
    except RuntimeError as e:
        if any(code in str(e) for code in _SOFT_HISTORY_ERRORS):
            logger.debug(
                "slack: history denied for %s/%s (%s); empty day",
                channel_id,
                date_str,
                e,
            )
            # A soft error is not the channel saying the day's messages
            # are gone, so the empty day must not evict what it held.
            return DirListing(entries=[], window=True)
        raise
    blobs: list[FileStat] = []
    for msg in messages:
        for fmeta in msg.get("files", []) or []:
            # Tombstoned (deleted) and access-restricted file payloads carry
            # an id but no download URL and no byte size; read() ENOENTs on
            # them, so listing them would both surface phantom files and
            # break the sizes_always_known contract.
            if (
                not fmeta.get("id")
                or not fmeta.get("url_private_download")
                or fmeta.get("size") is None
            ):
                continue
            mimetype = fmeta.get("mimetype", "")
            blobs.append(
                FileStat(
                    name=file_blob_name(fmeta),
                    type=FileType.FILE,
                    content=content_type_for_mime(mimetype),
                    size=fmeta["size"],
                    modified=_slack_modified(fmeta.get("timestamp")),
                    extra={
                        "file_id": fmeta["id"],
                        "mimetype": mimetype,
                        "url_private_download": fmeta.get(
                            "url_private_download", ""
                        ),
                        "filetype": fmeta.get("filetype", ""),
                        "ts": msg.get("ts", ""),
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
    accessor: SlackAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    # The day's row carries its channel: one the bounded window lists, or
    # one stat makes for any well-formed date under a real channel, so a
    # date outside the window fetches too.
    return await _day_listing(
        accessor, str(own.extra["channel_id"]), match.slots["day"]
    )


async def _list_files(
    accessor: SlackAccessor, match: ScopeMatch, own: FileStat
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
    listers={
        "channels_root": _list_channels_root,
        "dms_root": _list_dms_root,
        "users_root": _list_users_root,
    },
    entry_listers={
        "channel": _list_channel_days,
        "day": _list_day,
        "files": _list_files,
    },
    static_root=VIRTUAL_ROOTS,
    guards={"day": guard_day, "files": guard_day},
    pattern_kinds={"channel": has_glob_span},
)

__all__ = ["readdir", "VIRTUAL_ROOTS"]
