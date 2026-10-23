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
from functools import partial
from typing import Any

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.date_query import (
    date_dir_to_gmail_query,
    span_to_gmail_query,
)
from mirage.core.gmail.messages import (
    _extract_attachments,
    _extract_header,
    message_json_bytes,
)
from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.readdir import Listed, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import entry_stat
from mirage.types import ContentType, DirListing, FileStat, FileType
from mirage.utils.glob_walk import glob_span, has_glob_span
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_length, sanitize_label

TITLE_MAX = 80
MSG_SUFFIX = ".gmail.json"
MAX_MESSAGES = 50

_sanitize = partial(sanitize_label, fallback="No_Subject", max_len=TITLE_MAX)


def _subject(subject: str, msg_id: str) -> str:
    """Sanitize a subject to fit what the id and suffix leave of NAME_MAX.

    80 characters is 240 bytes of CJK, which overflows the 255-byte
    NAME_MAX once the id and `.gmail.json` are added; the filesystem
    rejects the name outright. Both the message file and its attachment
    directory take the file's (stricter) budget so one subject renders
    the same in both, rather than the directory getting the eleven bytes
    the suffix would have used.

    Args:
        subject (str): raw subject header.
        msg_id (str): the Gmail message id the name embeds.

    Returns:
        str: the sanitized subject segment.
    """
    fixed = len("__") + byte_length(msg_id) + len(MSG_SUFFIX)
    return _sanitize(subject, max_bytes=NAME_MAX_BYTES - fixed)


def _msg_filename(subject: str, msg_id: str) -> str:
    return f"{_subject(subject, msg_id)}__{msg_id}{MSG_SUFFIX}"


def _attach_dir_name(subject: str, msg_id: str) -> str:
    return f"{_subject(subject, msg_id)}__{msg_id}"


def _date_from_internal(internal_date: str) -> str:
    ts = int(internal_date) / 1000
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


ATTACHMENT = entry_stat("attachment_id")


def _attachment_entries(payload: dict[str, Any]) -> list[FileStat]:
    return [
        ATTACHMENT(
            att["filename"],
            att["attachment_id"],
            size=att["size"],
        )
        for att in _extract_attachments(payload)
    ]


def _date_children(
    raws: list[dict[str, Any]],
    keep_text: bool,
) -> tuple[list[FileStat], dict[str, list[FileStat]]]:
    """One date directory's children, plus its attachment-dir seeds.

    Args:
        raws (list[dict]): the date's full message payloads.
        keep_text (bool): whether each message's row keeps its rendered
            text, lowercased, for grep (``content_search``).
    """
    children: list[FileStat] = []
    seeds: dict[str, list[FileStat]] = {}
    for raw in raws:
        mid = raw["id"]
        headers = raw.get("payload", {}).get("headers", [])
        subject = _extract_header(headers, "Subject") or "No Subject"
        size_estimate = raw.get("sizeEstimate")
        rendered = message_json_bytes(raw)
        # The listing already fetched the full message, so the exact
        # rendered .gmail.json length and text are free; sizeEstimate is
        # the source message size and stays in extra. The kept text
        # leaves the labels out, the one field that changes after the
        # listing, which a search declines to rule on instead.
        extra: dict[str, Any] = {"message_id": mid}
        if keep_text:
            unlabeled = message_json_bytes({**raw, "labelIds": []})
            extra["text"] = unlabeled.decode().lower()
        if size_estimate is not None:
            extra["size_estimate"] = size_estimate
        children.append(
            FileStat(
                name=_msg_filename(subject, mid),
                type=FileType.FILE,
                content=ContentType.JSON,
                size=len(rendered),
                extra=extra,
            )
        )
        att_entries = _attachment_entries(raw.get("payload", {}))
        if att_entries:
            att_dir = _attach_dir_name(subject, mid)
            children.append(
                FileStat(
                    name=att_dir,
                    type=FileType.DIRECTORY,
                    extra={"message_id": mid},
                )
            )
            seeds[att_dir] = att_entries
    return children, seeds


async def _group_by_date(
    accessor: GmailAccessor, msg_ids: list[dict[str, Any]]
) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for m in msg_ids:
        raw = await accessor.gmail.get_message_raw(m["id"])
        date_str = _date_from_internal(raw.get("internalDate", "0"))
        groups.setdefault(date_str, []).append(raw)
    return groups


async def _list_root(accessor: GmailAccessor, match: ScopeMatch) -> Listed:
    labels = await accessor.gmail.list_labels()
    return [
        FileStat(
            name=(
                lb["id"]
                if lb.get("type") == "system"
                else lb.get("name", lb["id"])
            ),
            type=FileType.DIRECTORY,
            extra={"label_id": lb["id"]},
        )
        for lb in labels
    ]


async def _list_label(
    accessor: GmailAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    # The bare listing is a window, the most recent MAX_MESSAGES, so the
    # day dirs it mints are whichever days those fell on. A glob pushes
    # its own span into the query instead of filtering that window,
    # which is the only way to reach a day older than it.
    span = glob_span(match.pattern)
    label_id = str(own.extra["label_id"])
    msg_ids = await accessor.gmail.list_messages(
        label_id=label_id,
        query=span_to_gmail_query(*span) if span else None,
        max_results=MAX_MESSAGES,
    )
    groups = await _group_by_date(accessor, msg_ids)
    entries: list[FileStat] = []
    seeds: dict[str, list[FileStat]] = {}
    for date_str in sorted(groups.keys(), reverse=True):
        entries.append(
            FileStat(
                name=date_str,
                type=FileType.DIRECTORY,
                extra={"label_id": label_id},
            )
        )
        children, att_seeds = _date_children(
            groups[date_str], accessor.config.content_search
        )
        seeds[date_str] = children
        for att_dir, att_entries in att_seeds.items():
            seeds[f"{date_str}/{att_dir}"] = att_entries
    return DirListing(
        entries=entries, seeds=seeds, partial=span is not None, window=True
    )


async def _list_day(
    accessor: GmailAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    # The day's row carries its label: one the label's bounded recent
    # listing minted, or one stat makes for any well-formed day under a
    # real label, since a date query answers for any day.
    date_query = date_dir_to_gmail_query(match.slots["day"])
    if date_query is None:
        return []
    msg_ids = await accessor.gmail.list_messages(
        label_id=str(own.extra["label_id"]),
        query=date_query,
        max_results=MAX_MESSAGES,
    )
    groups = await _group_by_date(accessor, msg_ids)
    children, att_seeds = _date_children(
        groups.get(match.slots["day"], []), accessor.config.content_search
    )
    return DirListing(entries=children, seeds=att_seeds, window=True)


async def _list_attachment_dir(
    accessor: GmailAccessor, match: ScopeMatch, own: FileStat
) -> Listed:
    raw = await accessor.gmail.get_message_raw(str(own.extra["message_id"]))
    return _attachment_entries(raw.get("payload", {}))


readdir = make_readdir(
    detect_scope,
    listers={"root": _list_root},
    entry_listers={
        "label": _list_label,
        "day": _list_day,
        "attachment_dir": _list_attachment_dir,
    },
    pattern_kinds={"label": has_glob_span},
)
