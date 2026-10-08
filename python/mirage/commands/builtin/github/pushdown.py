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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_pushdown import (
    text_candidates,
    whole_word_literal,
)
from mirage.core.github.constants import SCOPE_ERROR, SCOPE_WARN
from mirage.core.github.pushdown import (
    count_scope_files,
    is_directory_key,
    scope_relative_key,
    search_safe,
    should_use_search,
)
from mirage.core.github.readdir import readdir
from mirage.core.github.repo import ensure_default_branch, ensure_ref
from mirage.core.github.search import narrow_paths
from mirage.core.github.stat import stat
from mirage.core.github.tree import ensure_tree
from mirage.types import PathSpec
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_prefix_of

# Glob expansion over the repository tree, capped as the mount caps it.
resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR, stat=stat)


def scope_refusal(command: str, file_count: int, whole_word: bool) -> str:
    """The refusal for a scope too large to scan without a narrowing.

    Push-down needs ``-w`` (see :func:`narrow_scope`), so without it the
    remedy is ``-w``; with it, code search ran and its answer could not be
    trusted as the whole set, so only a narrower path is left.

    Args:
        command (str): ``grep`` or ``rg``.
        file_count (int): files in scope.
        whole_word (bool): True if -w is set.

    Returns:
        str: the stderr line.
    """
    if whole_word:
        return (
            f"{command}: {file_count} files in scope and code search "
            "could not narrow them; narrow the path\n"
        )
    return (
        f"{command}: {file_count} files in scope, "
        "narrow the path, or use -w to enable code search\n"
    )


async def narrow_scope(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
    pattern: str | None,
    *,
    fixed_string: bool,
    recursive: bool,
    whole_word: bool,
    exact_file_set: bool = False,
) -> tuple[list[PathSpec], int, bool]:
    """Resolve grep/rg scope paths, narrowing via GitHub code search.

    Narrows any recursive scope (repo root or subdirectory) on the default
    branch when a whole-word literal can be pushed down to code search
    (``whole_word_literal``) and the scope is larger than ``SCOPE_WARN``;
    otherwise expands the scope by glob. Code search is trusted only where
    it can answer for the whole scope: never over a truncated tree, which
    cannot list every file the search skips; only over directory operands,
    since a full scan reads a file named on the line whatever its
    extension; only for a literal the search grammar reads as plain terms
    (``search_safe``); and only for an answer that is the whole set
    (``narrow_paths``). Binary-extension candidates are dropped from the
    narrowed set because the recursive walk it replaces skips them.

    Args:
        accessor (GitHubAccessor): backend handle.
        index (IndexCacheStore): populated path/size index.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.
        pattern (str | None): the search pattern, or None for -f-only greps.
        fixed_string (bool): True if -F is set.
        recursive (bool): True if -r/-R is set.
        exact_file_set (bool): Bypass narrowing when every file is needed.
        whole_word (bool): True if -w is set; required for push-down.

    Returns:
        tuple[list[PathSpec], int, bool]: resolved file paths, the file count
            in scope (narrowed count when search was used), and whether code
            search narrowed the set. A narrowed set may be empty (every
            candidate was binary); callers must not treat that as a stdin
            run.
    """
    key = scope_relative_key(paths[0])
    # Both facts below are hydrated on first use, not at construction:
    # the scope count reads the git tree, and the push-down is only
    # offered on the default branch.
    await ensure_tree(
        accessor, index, mount_prefix_of(paths[0].virtual, paths[0].vfs_path)
    )
    file_count = count_scope_files(accessor.tree, key)
    query = whole_word_literal(pattern, fixed_string, whole_word)
    # The scope size sits ahead of should_use_search: it is free, and
    # resolving the default branch is the one term here that can cost a
    # request.
    if (
        query is not None
        and not exact_file_set
        and file_count > SCOPE_WARN
        and not accessor.truncated
        and all(
            is_directory_key(accessor.tree, scope_relative_key(p))
            for p in paths
        )
        and search_safe(query)
        and should_use_search(
            recursive=recursive,
            on_default_branch=(
                await ensure_ref(accessor)
                == await ensure_default_branch(accessor)
            ),
        )
    ):
        narrowed = await narrow_paths(accessor, query, paths)
        if narrowed:
            kept = text_candidates(narrowed)
            return kept, len(kept), True
    resolved = await resolve_glob(accessor, paths, index)
    return resolved, file_count, False
