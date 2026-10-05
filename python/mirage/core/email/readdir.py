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

from email.utils import parsedate_to_datetime
from functools import partial
from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexEntry
from mirage.core.email.client import (
    INTERNAL_DATE_KEY,
    fetch_headers,
    list_message_uids,
)
from mirage.core.email.folders import list_folders
from mirage.core.email.render import message_json_bytes
from mirage.core.email.scope import detect_scope
from mirage.core.hierarchy.readdir import DirListing, Listed, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_length, sanitize_label

TITLE_MAX = 80
EPOCH_DATE = "1970-01-01"
MSG_SUFFIX = ".email.json"

_sanitize = partial(sanitize_label, fallback="No_Subject", max_len=TITLE_MAX)


def _msg_filename(subject: str, uid: str) -> str:
    # 80 characters is 240 bytes of CJK, which overflows the 255-byte
    # NAME_MAX once the uid and `.email.json` are added, so the subject
    # takes what they leave rather than a flat character count.
    fixed = len("__") + byte_length(uid) + len(MSG_SUFFIX)
    label = _sanitize(subject, max_bytes=NAME_MAX_BYTES - fixed)
    return f"{label}__{uid}{MSG_SUFFIX}"


def _parse_date(value: str) -> str | None:
    if not value.strip():
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    # The calendar date as written, with no zone conversion. RFC 3501
    # defines SENTON/SENTBEFORE/SENTSINCE (and ON/BEFORE/SINCE) as
    # comparing the date "disregarding time and timezone", so a message
    # written 05 Jan 23:30 -0500 answers a search for the 5th and has to
    # sit in the 5th's directory. Converting to UTC would file it under
    # the 6th and the search would select mail the directory lacks.
    return dt.strftime("%Y-%m-%d")


def _date_bucket(message: dict[str, Any]) -> str:
    """Pick the YYYY-MM-DD directory a message files under.

    The ``Date:`` header wins, because it is the timestamp the sender
    wrote and the one himalaya's date conditions search on (SENTON /
    SENTSINCE / SENTBEFORE). It is also optional, and a message without
    it used to fall straight to the epoch, collapsing the mount's only
    organizing axis into a single 1970 directory. IMAP's own
    INTERNALDATE (RFC 3501, server-assigned and always present) fills
    that hole.

    Args:
        message (dict): a fetched message carrying ``date`` and
            ``internal_date``.

    Returns:
        str: the bucket name, ``1970-01-01`` when neither timestamp
            parses.
    """
    header = _parse_date(str(message.get("date", "")))
    if header is not None:
        return header
    internal = _parse_date(str(message.get(INTERNAL_DATE_KEY, "")))
    return internal if internal is not None else EPOCH_DATE


def _date_children(
    headers: list[dict[str, Any]],
) -> tuple[
    list[tuple[str, IndexEntry]], dict[str, list[tuple[str, IndexEntry]]]
]:
    """One date directory's children, plus its attachment-dir seeds.

    Args:
        headers (list[dict]): the date's fetched message headers.
    """
    children: list[tuple[str, IndexEntry]] = []
    seeds: dict[str, list[tuple[str, IndexEntry]]] = {}
    for hdr in headers:
        uid = hdr["uid"]
        subject = hdr.get("subject", "") or "No Subject"
        filename = _msg_filename(subject, uid)
        children.append(
            (
                filename,
                IndexEntry(
                    id=uid,
                    name=subject,
                    resource_type="email/message",
                    vfs_name=filename,
                    size=len(message_json_bytes(hdr)),
                ),
            )
        )
        attachments = hdr.get("attachments", [])
        if attachments:
            att_dir_name = filename.replace(".email.json", "")
            children.append(
                (
                    att_dir_name,
                    IndexEntry(
                        id=uid,
                        name=att_dir_name,
                        resource_type="email/attachment_dir",
                        vfs_name=att_dir_name,
                    ),
                )
            )
            seeds[att_dir_name] = [
                (
                    att["filename"],
                    IndexEntry(
                        id=att["filename"],
                        name=att["filename"],
                        resource_type="email/attachment",
                        vfs_name=att["filename"],
                        size=att.get("size"),
                    ),
                )
                for att in attachments
            ]
    return children, seeds


async def _folder_headers(
    accessor: EmailAccessor, folder_name: str
) -> list[dict[str, Any]]:
    uids = await list_message_uids(
        accessor, folder_name, max_results=accessor.config.max_messages
    )
    return await fetch_headers(accessor, folder_name, uids)


async def _list_root(accessor: EmailAccessor, match: ScopeMatch) -> Listed:
    folders = await list_folders(accessor)
    return [
        (
            name,
            IndexEntry(
                id=name,
                name=name,
                resource_type="email/folder",
                vfs_name=name,
            ),
        )
        for name in folders
    ]


async def _list_folder(
    accessor: EmailAccessor, match: ScopeMatch, own: IndexEntry
) -> Listed:
    headers_list = await _folder_headers(accessor, own.id)
    date_groups: dict[str, list[dict[str, Any]]] = {}
    for hdr in headers_list:
        date_groups.setdefault(_date_bucket(hdr), []).append(hdr)
    entries: list[tuple[str, IndexEntry]] = []
    seeds: dict[str, list[tuple[str, IndexEntry]]] = {}
    for date_str in sorted(date_groups.keys(), reverse=True):
        entries.append(
            (
                date_str,
                IndexEntry(
                    id=date_str,
                    name=date_str,
                    resource_type="email/date",
                    vfs_name=date_str,
                ),
            )
        )
        children, att_seeds = _date_children(date_groups[date_str])
        seeds[date_str] = children
        for att_dir, att_entries in att_seeds.items():
            seeds[f"{date_str}/{att_dir}"] = att_entries
    return DirListing(entries=entries, seeds=seeds, window=True)


async def _list_day(
    accessor: EmailAccessor, match: ScopeMatch, own: IndexEntry
) -> Listed:
    # Normally served from the folder lister's seed; reached only when
    # the index evicted the day listing while the date entry survived.
    headers_list = await _folder_headers(accessor, match.slots["folder"])
    day = match.slots["day"]
    children, att_seeds = _date_children(
        [hdr for hdr in headers_list if _date_bucket(hdr) == day]
    )
    return DirListing(entries=children, seeds=att_seeds, window=True)


async def _list_attachment_dir(
    accessor: EmailAccessor, match: ScopeMatch, own: IndexEntry
) -> Listed:
    # Same eviction fallback: one header fetch rebuilds the listing.
    headers_list = await fetch_headers(
        accessor, match.slots["folder"], [own.id]
    )
    for hdr in headers_list:
        _, seeds = _date_children([hdr])
        for att_entries in seeds.values():
            return att_entries
    return []


readdir = make_readdir(
    detect_scope,
    listers={"root": _list_root},
    entry_listers={
        "folder": _list_folder,
        "day": _list_day,
        "attachment_dir": _list_attachment_dir,
    },
)
