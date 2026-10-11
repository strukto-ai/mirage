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

import asyncio
import logging
from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.core.email.client import (
    fetch_headers,
    list_message_uids,
    quote_string,
)
from mirage.core.email.readdir import _date_bucket, _msg_filename
from mirage.core.email.scope import NATIVE_KINDS, detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import record_queries

logger = logging.getLogger(__name__)

# What a mounted .email.json holds besides the headers and body IMAP
# searches: its key names, JSON literals, the system flags and the name
# an unnamed attachment is given.
RECORD_KEYS = frozenset(
    {
        "from",
        "name",
        "email",
        "reply_to",
        "to",
        "cc",
        "subject",
        "date",
        "body_text",
        "body_html",
        "snippet",
        "message_id",
        "in_reply_to",
        "references",
        "has_attachments",
        "attachments",
        "filename",
        "content_type",
        "size",
        "uid",
        "flags",
        "true",
        "false",
        "null",
        "seen",
        "answered",
        "flagged",
        "deleted",
        "draft",
        "recent",
        "unnamed",
    }
)


def build_search_criteria(
    text: str | None = None,
    subject: str | None = None,
    from_addr: str | None = None,
    to_addr: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unseen: bool = False,
) -> str:
    """Spell the search as one IMAP SEARCH key sequence.

    Every text-valued key carries its value as a quoted string, so a
    quote or backslash inside it stays part of the value instead of
    ending it early and turning the rest into search keys. Dates are
    bare atoms, as the grammar has them.

    Args:
        text (str | None): substring of the headers or body (``TEXT``).
        subject (str | None): substring of the Subject header.
        from_addr (str | None): substring of the From header.
        to_addr (str | None): substring of the To header.
        since (str | None): ``dd-Mon-yyyy`` lower bound on arrival.
        before (str | None): ``dd-Mon-yyyy`` upper bound on arrival.
        unseen (bool): only messages without ``\\Seen``.

    Returns:
        str: the keys joined by spaces, ``ALL`` when there are none.
    """
    parts: list[str] = []
    if unseen:
        parts.append("UNSEEN")
    if text:
        parts.append(f"TEXT {quote_string(text)}")
    if subject:
        parts.append(f"SUBJECT {quote_string(subject)}")
    if from_addr:
        parts.append(f"FROM {quote_string(from_addr)}")
    if to_addr:
        parts.append(f"TO {quote_string(to_addr)}")
    if since:
        parts.append(f"SINCE {since}")
    if before:
        parts.append(f"BEFORE {before}")
    return " ".join(parts) if parts else "ALL"


async def search_messages(
    accessor: EmailAccessor,
    folder: str,
    text: str | None = None,
    subject: str | None = None,
    from_addr: str | None = None,
    to_addr: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unseen: bool = False,
    max_results: int | None = None,
) -> list[str]:
    criteria = build_search_criteria(
        text=text,
        subject=subject,
        from_addr=from_addr,
        to_addr=to_addr,
        since=since,
        before=before,
        unseen=unseen,
    )
    return await list_message_uids(
        accessor, folder, criteria, max_results=max_results
    )


def _build_vfs_path(prefix: str, folder: str, msg: dict[str, Any]) -> str:
    date_str = _date_bucket(msg)
    uid = msg.get("uid", "")
    # The same builder readdir names the file with, not a second spelling of
    # it: the subject's budget depends on the uid and the suffix, so a hit
    # composed here from a bare `_sanitize` pointed at a path that does not
    # exist as soon as a long subject was trimmed differently.
    filename = _msg_filename(msg.get("subject", "No Subject"), uid)
    parts = [prefix, folder, date_str, filename]
    return "/".join(p for p in parts if p)


async def files_containing(
    accessor: EmailAccessor,
    text: str,
    under: list[PathSpec],
    whole_word: bool,
) -> list[PathSpec] | None:
    """The message files under ``under`` IMAP SEARCH TEXT names.

    IMAP matches a substring of the headers or body in any case, so each
    hit is a message that may hold ``text``; its file is named from its
    Subject and Date, fetched alone. A day is asked for its whole folder.
    None when a scope is not a folder or a day, when ``text`` could match
    the JSON outside the headers and body (``record_queries``), when more
    than ``max_messages`` match (the newest would leave out older ones a
    cached listing still holds), or when the server fails.

    Args:
        accessor (EmailAccessor): the account.
        text (str): what grep or rg searches for.
        under (list[PathSpec]): the directories walked.
        whole_word (bool): whether only whole words of ``text`` match.
    """
    queries = record_queries(text, RECORD_KEYS, whole_word)
    if queries is None:
        return None
    found: list[PathSpec] = []
    for scope in under:
        match = detect_scope(scope)
        if match.kind not in NATIVE_KINDS:
            return None
        folder = match.slots["folder"]
        segment = scope.mount_path.strip("/").split("/")[0]
        cap = accessor.config.max_messages
        try:
            uids: set[str] = set()
            for query in queries:
                matched = await search_messages(
                    accessor, folder, text=query, max_results=cap + 1
                )
                if len(matched) > cap:
                    return None
                uids.update(matched)
            named = await fetch_headers(
                accessor, folder, sorted(uids, key=int), header_only=True
            )
        except (OSError, ValueError, asyncio.TimeoutError) as exc:
            logger.warning("imap search failed (%s); reading every file", exc)
            return None
        found.extend(
            mounted_path(scope, "/" + _build_vfs_path("", segment, msg))
            for msg in named
        )
    return found
