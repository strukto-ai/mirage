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

from mirage.accessor.linear import LinearAccessor
from mirage.core.hierarchy.probe import row_at, rows_of
from mirage.core.hierarchy.scope import ROOT
from mirage.core.linear.client import search_issues
from mirage.core.linear.readdir import readdir
from mirage.core.linear.scope import detect_scope
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import may_hold, record_queries

logger = logging.getLogger(__name__)

# The most issues one search answers; a full page may have left some out.
SEARCH_LIMIT = 250

# The words an issue's JSON holds whatever its text says: its letter-only
# key names and the JSON literals. Every other field Linear does not
# search is checked against the listing (``unsearched_text``).
RECORD_KEYS = frozenset(
    {"title", "description", "priority", "url", "true", "false", "null"}
)

# A team's directories whose files' listing entries keep their text
# (``kept_text``).
KEPT_DIRS = ("members", "projects", "cycles", "documents")


def _child(directory: PathSpec, name: str) -> PathSpec:
    return mounted_path(
        directory, f"{directory.mount_path.rstrip('/')}/{name}"
    )


Walked = list[tuple[PathSpec, FileStat, FileStat | None]]


async def _listed(
    accessor: LinearAccessor,
    directory: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> Walked:
    """A directory's children, each with its row and the directory's.

    Args:
        accessor (LinearAccessor): the workspace.
        directory (PathSpec): the directory.
        entry (FileStat | None): its row.
        parent (FileStat | None): its parent's row.
    """
    rows = rows_of(await readdir(accessor, directory, entry, parent))
    return [(_child(directory, row.name), row, entry) for row in rows]


async def _walked(
    accessor: LinearAccessor, scope: PathSpec
) -> tuple[Walked, Walked] | None:
    """The ``issues`` directories and the kept-text directories under
    ``scope``, each with its row and its team's; None for a scope inside
    an issue.
    """
    match = detect_scope(scope)
    if match.kind in (ROOT, "teams"):
        teams = await _listed(
            accessor, mounted_path(scope, "/teams"), None, None
        )
    elif match.kind in ("team", "issues", *KEPT_DIRS):
        entry, parent = await row_at(readdir, accessor, scope)
        if entry is None:
            return None
        if match.kind == "issues":
            return [(scope, entry, parent)], []
        if match.kind != "team":
            return [], [(scope, entry, parent)]
        teams = [(scope, entry, parent)]
    else:
        return None
    issue_dirs: Walked = []
    kept_dirs: Walked = []
    for team, row, _ in teams:
        for child in await _listed(accessor, team, row, None):
            if child[1].name == "issues":
                issue_dirs.append(child)
            elif child[1].name in KEPT_DIRS:
                kept_dirs.append(child)
    return issue_dirs, kept_dirs


async def _named(
    accessor: LinearAccessor, text: str
) -> tuple[list[list[str]], dict[str, set[str]]] | None:
    """Each searched text's words, and the issues Linear names for each
    word; None when the text cannot be searched or a search fails or
    answers a full page.
    """
    queries = record_queries(text, RECORD_KEYS, whole_word=True)
    if queries is None:
        return None
    asked = [query.lower().split() for query in queries]
    named: dict[str, set[str]] = {}
    try:
        for word in sorted({word for words in asked for word in words}):
            nodes = await search_issues(accessor, word, SEARCH_LIMIT)
            if len(nodes) >= SEARCH_LIMIT:
                return None
            named[word] = {str(node.get("id")) for node in nodes}
    except (OSError, aiohttp.ClientError, RuntimeError, ValueError) as exc:
        logger.debug("linear search failed (%s); reading every issue", exc)
        return None
    return asked, named


async def files_containing(
    accessor: LinearAccessor,
    text: str,
    under: list[PathSpec],
    *,
    ask_linear: bool,
) -> list[PathSpec] | None:
    """The files under ``under`` that may hold ``text``: the
    ``issue.json`` files Linear's search names or whose other fields hold
    it, and the member, project, cycle and document files whose text
    holds it.

    Linear searches an issue's title and description by word, so with
    ``ask_linear`` each word is asked on its own, and an issue is read
    when each word is either named there or held by the text the listing
    kept (``unsearched_text``): the rest of its JSON (team, project,
    cycle, state, people, labels, dates, link), and the words of those two
    the search may split otherwise. The text goes through
    ``record_queries`` for its key names and escapes. Every issue is read
    without ``ask_linear``, when the text cannot be searched, a search
    fails or answers a full page, or nothing is found, since Linear
    indexes a write some time after it lands. A member, project, cycle or
    document file is read when the text its row kept (``kept_text``)
    holds ``text`` in any case, or when it was too large to keep. The
    walk lists each directory from Linear, so the kept text is checked
    against the records as they are now. None for a text that is not
    ASCII or a scope inside an issue.

    Args:
        accessor (LinearAccessor): the workspace.
        text (str): plain text every match holds.
        under (list[PathSpec]): the directories walked.
        ask_linear (bool): whether Linear's issue search may be asked,
            for a whole word under a ``walk_limit``.
    """
    if not text.isascii():
        return None
    try:
        return await _found(accessor, text.lower(), under, ask_linear)
    except (OSError, aiohttp.ClientError, RuntimeError, ValueError) as exc:
        logger.debug("linear listing failed (%s); reading every file", exc)
        return None


async def _found(
    accessor: LinearAccessor,
    needle: str,
    under: list[PathSpec],
    ask_linear: bool,
) -> list[PathSpec] | None:
    issue_dirs: Walked = []
    kept_dirs: Walked = []
    for scope in under:
        walked = await _walked(accessor, scope)
        if walked is None:
            return None
        issue_dirs += walked[0]
        kept_dirs += walked[1]
    issues: Walked = []
    for directory, row, above in issue_dirs:
        issues += await _listed(accessor, directory, row, above)
    answer = await _named(accessor, needle) if ask_linear and issues else None
    held: list[PathSpec] = []
    if answer is not None:
        for path, row, _ in issues:
            kept = row.extra.get("unsearched")
            if not isinstance(kept, str) or may_hold(
                *answer, str(row.extra.get("issue_id")), kept
            ):
                held.append(path)
    found = [
        _child(path, "issue.json")
        for path in held or [path for path, _, _ in issues]
    ]
    for directory, row, above in kept_dirs:
        for path, child, _ in await _listed(accessor, directory, row, above):
            kept = child.extra.get("text")
            if not isinstance(kept, str) or needle in kept:
                found.append(path)
    return found
