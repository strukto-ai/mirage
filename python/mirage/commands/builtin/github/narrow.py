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

from collections.abc import Callable

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_helper import classify_pattern, search_query
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.spec.types import FlagView
from mirage.core.github.constants import SCOPE_WARN
from mirage.core.github.glob import resolve_glob
from mirage.core.github.scope import (count_scope_files, scope_relative_key,
                                      should_use_search)
from mirage.core.github.search import narrow_paths
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.path import rebase_raw


async def narrow_scope(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
    pattern: str | None,
    *,
    fixed_string: bool,
    recursive: bool,
) -> tuple[list[PathSpec], int, bool]:
    """Resolve grep/rg scope paths, narrowing via GitHub code search.

    Narrows any recursive scope (repo root or subdirectory) on the default
    branch when a literal can be pushed down to code search and the scope is
    larger than ``SCOPE_WARN``; otherwise expands the scope by glob. Regex
    patterns narrow on an extracted required literal and stay exact because the
    caller still scans the regex over the narrowed files.

    Args:
        accessor (GitHubAccessor): backend handle.
        index (IndexCacheStore): populated path/size index.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.
        pattern (str | None): the search pattern, or None for -f-only greps.
        fixed_string (bool): True if -F is set.
        recursive (bool): True if -r/-R is set.

    Returns:
        tuple[list[PathSpec], int, bool]: resolved file paths, the file count
            in scope (narrowed count when search was used), and whether code
            search actually narrowed the set.
    """
    key = scope_relative_key(paths[0])
    file_count = count_scope_files(await index.entries(), key)
    query = search_query(pattern,
                         fixed_string) if pattern is not None else None
    use_search = (query is not None and should_use_search(
        recursive=recursive,
        on_default_branch=(accessor.ref == accessor.default_branch),
    ) and file_count > SCOPE_WARN)
    if use_search:
        assert query is not None
        narrowed = await narrow_paths(accessor.config, accessor.owner,
                                      accessor.repo, query, paths)
        if narrowed:
            return narrowed, len(narrowed), True
    resolved = await resolve_glob(accessor, paths, index)
    return resolved, file_count, False


def files_only_shortcircuit(
    fl: FlagView,
    pattern: str | None,
    resolved: list[PathSpec],
    scope: PathSpec,
    path_predicate: Callable[[str], bool] | None = None,
) -> tuple[ByteSource, IOResult] | None:
    """Emit the narrowed file list for a plain literal -l without reading.

    When code search has already narrowed the scope to the files containing a
    fully literal pattern, those files are exactly the answer to ``-l``
    (files-with-matches), so the content fetches the generic command would do
    can be skipped entirely. Returns None whenever the short-circuit is unsafe
    (no -l, a non-literal pattern, or a flag that changes which lines match) so
    the caller falls back to the generic scan. ``path_predicate`` reproduces
    any file filtering the generic command applies (rg's hidden/--type/--glob
    rules); files it rejects are dropped, matching the generic output.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        pattern (str | None): the search pattern.
        resolved (list[PathSpec]): the narrowed file paths.
        scope (PathSpec): the original scope path, for display rebasing.
        path_predicate (Callable[[str], bool] | None): keeps only narrowed
            paths for which it returns True; None keeps all (grep semantics).

    Returns:
        tuple[ByteSource, IOResult] | None: the formatted file list, or None.
    """
    if not fl.as_bool("args_l") or pattern is None:
        return None
    if (fl.as_bool("i") or fl.as_bool("w") or fl.as_bool("v")
            or fl.as_bool("c") or fl.as_bool("o")):
        return None
    fixed = fl.as_bool("F")
    pt = classify_pattern(pattern, fixed)
    fully_literal = fixed or pt == PatternType.EXACT or (
        pt == PatternType.SIMPLE and "." not in pattern)
    if not fully_literal:
        return None
    hits = [
        p.virtual for p in resolved
        if path_predicate is None or path_predicate(p.virtual)
    ]
    if not hits:
        return b"", IOResult(exit_code=1)
    spelled = rebase_raw(hits, scope.virtual, scope.raw_path)
    return format_records(sorted(spelled)), IOResult()
