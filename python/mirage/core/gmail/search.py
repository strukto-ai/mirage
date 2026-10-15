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
import re

import aiohttp

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.readdir import readdir
from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.probe import row_at, rows_of
from mirage.core.hierarchy.scope import ROOT
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mounted_path

logger = logging.getLogger(__name__)

# The directories above a message, walked down to its files.
WALKED = frozenset({ROOT, "label", "day"})

# Gmail's system label ids, lowercased. With the account's own labels,
# ``Label_<n>``, they are all a message's labels field spells, and a
# message's labels change after the listing kept its text.
SYSTEM_LABELS = frozenset(
    {
        "inbox",
        "spam",
        "trash",
        "unread",
        "starred",
        "important",
        "sent",
        "draft",
        "chat",
        "category_personal",
        "category_social",
        "category_promotions",
        "category_updates",
        "category_forums",
    }
)
USER_LABEL = re.compile(r"[label_]*\d*")


def _child_of(directory: PathSpec, name: str) -> PathSpec:
    return mounted_path(
        directory, f"{directory.mount_path.rstrip('/')}/{name}"
    )


async def _label_ids(accessor: GmailAccessor, scope: PathSpec) -> set[str]:
    """The account's label ids, lowercased, from the mount root's listing.

    Args:
        accessor (GmailAccessor): the account.
        scope (PathSpec): any path on the mount.
    """
    listed = await readdir(accessor, mounted_path(scope, "/"))
    return {str(row.extra["label_id"]).lower() for row in rows_of(listed)}


def _in_labels(needle: str, labels: set[str]) -> bool:
    """Whether ``needle`` may lie in a message's labels field: across its
    quotes and commas, in a ``Label_<n>`` id, or in a label id."""
    return (
        any(char in needle for char in '"[],')
        or USER_LABEL.fullmatch(needle) is not None
        or any(needle in label for label in SYSTEM_LABELS | labels)
    )


async def files_containing(
    accessor: GmailAccessor,
    text: str,
    under: list[PathSpec],
) -> list[PathSpec] | None:
    """The message files under ``under`` whose text holds ``text`` in any
    case.

    Gmail's search reads a message's HTML part and can miss a word of the
    text/plain body a .gmail.json renders, such as one inside a link or
    one only that part holds, so it is not asked. The listing fetches
    every message in full anyway and, with ``content_search``, keeps each
    one's rendered text, lowercased, without its labels; the files are
    picked from that. None for a text that is not ASCII, whose case a
    lowercased copy may not keep, a text that may lie in a labels field
    (``_in_labels``), which changes after the listing, when a listing kept
    no text, or when a listing fails.

    Args:
        accessor (GmailAccessor): the account.
        text (str): plain text every match holds.
        under (list[PathSpec]): the directories walked.
    """
    if not text.isascii() or not under:
        return None
    needle = text.lower()
    found: list[PathSpec] = []
    try:
        labels = await _label_ids(accessor, under[0])
        if _in_labels(needle, labels):
            return None
        pending: list[tuple[PathSpec, FileStat | None]] = []
        for scope in under:
            if detect_scope(scope).kind in WALKED:
                pending.append(
                    (scope, (await row_at(readdir, accessor, scope))[0])
                )
        while pending:
            current, row = pending.pop()
            for child_row in rows_of(await readdir(accessor, current, row)):
                child = _child_of(current, child_row.name)
                kind = detect_scope(child).kind
                if kind in WALKED:
                    pending.append((child, child_row))
                elif kind == "message":
                    kept = child_row.extra.get("text")
                    if not isinstance(kept, str):
                        return None
                    if needle in kept:
                        found.append(child)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.debug("gmail listing failed (%s); reading every file", exc)
        return None
    return found
