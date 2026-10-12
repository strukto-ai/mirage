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

import aiohttp

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gmail.readdir import readdir
from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ROOT
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path

logger = logging.getLogger(__name__)

# The directories above a message, walked down to its files.
WALKED = frozenset({ROOT, "label", "day"})


def _child_of(directory: PathSpec, name: str) -> PathSpec:
    return mounted_path(
        directory, f"{directory.mount_path.rstrip('/')}/{name}"
    )


async def files_containing(
    accessor: GmailAccessor,
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The message files under ``under`` whose text holds ``text`` in any
    case.

    Gmail's search reads a message's HTML part and can miss a word of the
    text/plain body a .gmail.json renders, such as one inside a link or
    one only that part holds, so it is not asked. The listing fetches
    every message in full anyway and, with ``content_search``, keeps each
    one's rendered text, lowercased; the files are picked from that. None
    for a text that is not ASCII, whose case a lowercased copy may not
    keep, when a listing kept no text, or when a listing fails.

    Args:
        accessor (GmailAccessor): the account.
        text (str): plain text every match holds.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the listings the walk filled.
    """
    if not text.isascii():
        return None
    needle = text.lower()
    found: list[PathSpec] = []
    pending = [scope for scope in under if detect_scope(scope).kind in WALKED]
    try:
        while pending:
            current = pending.pop()
            for listed in await readdir(accessor, current, index):
                child = _child_of(current, listed.rsplit("/", 1)[-1])
                kind = detect_scope(child).kind
                if kind in WALKED:
                    pending.append(child)
                elif kind == "message":
                    entry = await resolve_entry(
                        readdir, accessor, child, index
                    )
                    kept = None if entry is None else entry.extra.get("text")
                    if not isinstance(kept, str):
                        return None
                    if needle in kept:
                        found.append(child)
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.warning("gmail listing failed (%s); reading every file", exc)
        return None
    return found
