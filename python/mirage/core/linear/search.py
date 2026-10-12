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
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ROOT
from mirage.core.linear.client import search_issues
from mirage.core.linear.readdir import readdir
from mirage.core.linear.scope import detect_scope
from mirage.types import PathSpec
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


async def _issue_dirs(
    accessor: LinearAccessor,
    scope: PathSpec,
    index: IndexCacheStore,
) -> dict[str, tuple[PathSpec, str]] | None:
    """Each issue directory under ``scope`` with its kept text, by issue
    id; None for a scope inside an issue or a listing that keeps no
    unsearched text.
    """
    match = detect_scope(scope)
    base = scope.mount_path.rstrip("/")
    if match.kind in (ROOT, "teams"):
        root = mounted_path(scope, "/teams")
        teams = [
            mounted_path(root, f"/teams/{name.rsplit('/', 1)[-1]}/issues")
            for name in await readdir(accessor, root, index)
        ]
    elif match.kind == "team":
        teams = [mounted_path(scope, f"{base}/issues")]
    elif match.kind == "issues":
        teams = [scope]
    elif match.kind in ("members", "projects", "cycles", "documents"):
        teams = []
    else:
        return None
    dirs: dict[str, tuple[PathSpec, str]] = {}
    for issues in teams:
        parent = issues.mount_path.rstrip("/")
        for listed in await readdir(accessor, issues, index):
            leaf = listed.rsplit("/", 1)[-1]
            child = mounted_path(issues, f"{parent}/{leaf}")
            entry = await resolve_entry(readdir, accessor, child, index)
            if entry is None or "unsearched" not in entry.extra:
                return None
            dirs[entry.id] = (child, entry.extra["unsearched"])
    return dirs


async def files_containing(
    accessor: LinearAccessor,
    text: str,
    under: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec] | None:
    """The ``issue.json`` files under ``under`` whose issue Linear's search
    names, or whose other fields hold ``text``.

    Linear searches an issue's title and description by word, so each
    word is asked on its own, and an issue is read when each word is
    either named there or held by the text the listing kept
    (``unsearched_text``): the rest of its JSON (team, project, cycle,
    state, people, labels, dates, link), and the words of those two the
    search may split otherwise. The text goes through ``record_queries``
    for its key names and escapes. None when the text cannot be searched,
    a scope lies inside an issue, a search answers a full page or fails,
    or nothing is found, since Linear indexes a write some time after it
    lands.

    Args:
        accessor (LinearAccessor): the workspace.
        text (str): the whole word or words searched for.
        under (list[PathSpec]): the directories walked.
        index (IndexCacheStore): the mount's index.
    """
    queries = record_queries(text, RECORD_KEYS, whole_word=True)
    if queries is None:
        return None
    asked = [query.lower().split() for query in queries]
    found: list[PathSpec] = []
    try:
        named: dict[str, set[str]] = {}
        for word in sorted({word for words in asked for word in words}):
            nodes = await search_issues(
                accessor.config, word, SEARCH_LIMIT, session=accessor.pool
            )
            if len(nodes) >= SEARCH_LIMIT:
                return None
            named[word] = {str(node.get("id")) for node in nodes}
        for scope in under:
            dirs = await _issue_dirs(accessor, scope, index)
            if dirs is None:
                return None
            found.extend(
                mounted_path(path, f"{path.mount_path.rstrip('/')}/issue.json")
                for issue_id, (path, kept) in dirs.items()
                if may_hold(asked, named, issue_id, kept)
            )
    except (OSError, aiohttp.ClientError, RuntimeError, ValueError) as exc:
        logger.warning("linear search failed (%s); reading every file", exc)
        return None
    return found or None
