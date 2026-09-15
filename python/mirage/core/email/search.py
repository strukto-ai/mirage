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

from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.core.email.client import (fetch_message, list_message_uids,
                                      quote_string)
from mirage.core.email.readdir import _date_bucket, _msg_filename
from mirage.core.email.render import message_json_text


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
    return await list_message_uids(accessor,
                                   folder,
                                   criteria,
                                   max_results=max_results)


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


async def search_and_format(
    accessor: EmailAccessor,
    folder: str,
    query: str,
    prefix: str,
    max_results: int | None = None,
) -> list[tuple[str, str]]:
    """Run a native TEXT search and return (vfs_path, message_json) pairs.

    ``query`` is the substring IMAP is asked for, never a caller's regex:
    the server matches it case-insensitively against the raw message, so
    a grep hands over the literal every match must contain and runs its
    real pattern over the rendered text itself.

    Args:
        accessor (EmailAccessor): the account.
        folder (str): the mailbox to search.
        query (str): the substring every candidate must contain.
        prefix (str): the mount prefix hits are spelled under.
        max_results (int | None): keep only the newest this many uids.
    """
    if not folder:
        return []
    uids = await search_messages(accessor,
                                 folder,
                                 text=query,
                                 max_results=max_results)
    pairs: list[tuple[str, str]] = []
    for uid in uids:
        msg = await fetch_message(accessor, folder, uid)
        msg_text = message_json_text(msg)
        vfs_path = _build_vfs_path(prefix, folder, msg)
        pairs.append((vfs_path, msg_text))
    return pairs
