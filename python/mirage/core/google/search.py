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
from collections.abc import Awaitable, Callable
from typing import TypeVar

import aiohttp

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.google.constants import RENDERED_WORDS, TOP_LEVEL_DIRS
from mirage.core.google.drive import search_files
from mirage.types import DirListing, FileStat, PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import record_queries

logger = logging.getLogger(__name__)

A = TypeVar("A", bound=GoogleApiAccessor)


def drive_queries(text: str, vocabulary: frozenset[str]) -> list[str] | None:
    """The whole words Drive is asked for ``text`` over an app mount's
    JSON, or None when its index cannot stand in for grep: the
    ``record_queries`` of the text, with the app's API names and the
    words every rendering carries as keys. A digit, a JSON literal or a
    word an id can hold is never asked, and a word a JSON escape can run
    into is asked without its first letter too.

    Args:
        text (str): the whole word grep searches for.
        vocabulary (frozenset[str]): the app's API words, lowercased.
    """
    return record_queries(text, vocabulary | RENDERED_WORDS, whole_word=True)


async def files_containing(
    accessor: A,
    readdir: Callable[[A, PathSpec], Awaitable[list[FileStat] | DirListing]],
    mime: str,
    vocabulary: frozenset[str],
    text: str,
    under: list[PathSpec],
) -> list[PathSpec] | None:
    """The Docs, Sheets or Slides files under ``under`` Drive full-text
    search names.

    One query asks for every file of the app's MIME type holding the
    word, and the answer is matched by id against the owned and shared
    listings grep walks next. None for a word ``drive_queries`` turns
    down, a scope below a corpus, a listing or search that fails or that
    Drive did not finish, or an empty answer.

    Drive searches a file's text, so the answer can leave out one whose
    JSON holds the word only in a value that is not text (a font, a time
    zone, a link or image address, a tab title, an id or a formula), or
    only as part of a word styling splits into text runs (``snow`` bold in
    ``snowman``).

    Args:
        accessor (GoogleApiAccessor): backend handle.
        readdir (Callable): the app's readdir.
        mime (str): the app's MIME type.
        vocabulary (frozenset[str]): the app's API words, lowercased.
        text (str): the whole word searched for.
        under (list[PathSpec]): the directories walked.
    """
    queries = drive_queries(text, vocabulary)
    if queries is None:
        return None
    corpora: list[PathSpec] = []
    for directory in under:
        key = directory.vfs_path.strip("/")
        if not key:
            corpora.extend(
                mounted_path(directory, f"/{corpus}")
                for corpus in TOP_LEVEL_DIRS
            )
        elif key in TOP_LEVEL_DIRS:
            corpora.append(directory)
        else:
            return None
    found: list[PathSpec] = []
    try:
        named: set[str] = set()
        for query in queries:
            ids, complete = await search_files(
                accessor.token_manager, query, [], mime
            )
            if not complete:
                return None
            named.update(ids)
        for corpus in corpora:
            listed = await readdir(accessor, corpus)
            # An unfinished listing is not the directory, and grep's own
            # walk lists it again.
            if isinstance(listed, DirListing) and listed.partial:
                return None
            rows = listed.entries if isinstance(listed, DirListing) else listed
            base = corpus.mount_path.rstrip("/")
            found.extend(
                mounted_path(corpus, f"{base}/{row.name}")
                for row in rows
                if row.extra.get("doc_id") in named
            )
    except (OSError, aiohttp.ClientError) as exc:
        logger.debug("drive search failed (%s); reading every file", exc)
        return None
    return found or None
