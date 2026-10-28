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

import aiohttp

from mirage.accessor.trello import TrelloAccessor
from mirage.core.api.errors import ApiError
from mirage.core.hierarchy.probe import row_at, rows_of
from mirage.core.hierarchy.scope import ROOT
from mirage.core.trello.client import search_cards
from mirage.core.trello.readdir import readdir
from mirage.core.trello.scope import detect_scope
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import may_hold, record_queries

logger = logging.getLogger(__name__)

# The most cards one search answers; a full page may have left some out.
SEARCH_LIMIT = 1000

# The words a card's JSON holds whatever its text says: its letter-only
# key names and the JSON literals. Every other field Trello does not
# search is checked against the listing (``unsearched_text``).
RECORD_KEYS = frozenset(
    {"due", "closed", "desc", "url", "true", "false", "null"}
)

# The directories above a card, walked down to its cards.
WALKED = frozenset(
    {ROOT, "workspaces", "workspace", "boards", "board", "lists", "list"}
)


async def _cards(
    accessor: TrelloAccessor,
    scope: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> list[tuple[PathSpec, FileStat | None]] | None:
    """Each card directory under ``scope``, with the row its list's
    listing names; None for a scope inside a card.
    """
    kind = detect_scope(scope).kind
    if kind == "card":
        return [(scope, entry)]
    if kind in ("card_json", "comments_jsonl"):
        return None
    if kind not in WALKED and kind != "cards":
        return []
    base = scope.mount_path.rstrip("/")
    found: list[tuple[PathSpec, FileStat | None]] = []
    for row in rows_of(await readdir(accessor, scope, entry, parent)):
        child = mounted_path(scope, f"{base}/{row.name}")
        below = await _cards(accessor, child, row, entry)
        if below is None:
            return None
        found.extend(below)
    return found


async def files_containing(
    accessor: TrelloAccessor, text: str, under: list[PathSpec]
) -> list[PathSpec] | None:
    """The ``card.json`` files under ``under`` whose card Trello's search
    names, or whose other fields hold ``text``.

    Trello searches a card's name and description by word, so each word
    is asked on its own, and a card is read when each word is either
    named there or held by the text the listing kept
    (``unsearched_text``): the rest of its JSON (ids, due date, flags,
    link), and the words of those two the search may split otherwise. The
    walk lists each directory from Trello, so the kept text is checked
    against the cards as they are now. The text goes through
    ``record_queries`` for its key names and escapes. None when the text
    cannot be searched, a scope lies inside a card, a search answers a
    full page or fails, or nothing is found, since Trello indexes a write
    some time after it lands.

    Args:
        accessor (TrelloAccessor): the account.
        text (str): the whole word or words searched for.
        under (list[PathSpec]): the directories walked.
    """
    queries = record_queries(text, RECORD_KEYS, whole_word=True)
    if queries is None:
        return None
    asked = [query.lower().split() for query in queries]
    found: list[PathSpec] = []
    try:
        named: dict[str, set[str]] = {}
        for word in sorted({word for words in asked for word in words}):
            cards = await search_cards(accessor, word, SEARCH_LIMIT)
            if len(cards) >= SEARCH_LIMIT:
                return None
            named[word] = {str(card.get("id")) for card in cards}
        for scope in under:
            entry, parent = await row_at(readdir, accessor, scope)
            walked = await _cards(accessor, scope, entry, parent)
            if walked is None:
                return None
            for path, row in walked:
                if row is not None:
                    kept = row.extra.get("unsearched")
                    if not isinstance(kept, str):
                        return None
                    if not may_hold(
                        asked, named, str(row.extra.get("card_id")), kept
                    ):
                        continue
                found.append(
                    mounted_path(
                        path, f"{path.mount_path.rstrip('/')}/card.json"
                    )
                )
    except (
        OSError,
        aiohttp.ClientError,
        ApiError,
        RuntimeError,
        ValueError,
    ) as exc:
        logger.debug("trello search failed (%s); reading every file", exc)
        return None
    return found or None
