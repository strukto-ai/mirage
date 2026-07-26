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
from mirage.commands.builtin.github.io import resolve_glob
from mirage.commands.builtin.grep_helper import (is_literal_pattern,
                                                 search_query)
from mirage.core.github.constants import SCOPE_WARN
from mirage.core.github.scope import (count_scope_files, scope_relative_key,
                                      should_use_search)
from mirage.core.github.search import narrow_paths
from mirage.types import PathSpec


async def narrow_scope(
    accessor: GitHubAccessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
    pattern: str | None,
    *,
    fixed_string: bool,
    recursive: bool,
    whole_word: bool,
) -> tuple[list[PathSpec], int, bool]:
    """Resolve grep/rg scope paths, narrowing via GitHub code search.

    Narrows any recursive scope (repo root or subdirectory) on the default
    branch when a literal can be pushed down to code search and the scope is
    larger than ``SCOPE_WARN``; otherwise expands the scope by glob.

    Push-down requires ``-w`` and a fully literal pattern. GitHub code search
    matches whole words while grep matches substrings, so for a bare literal
    the search result is a strict subset of the grep matches: a file holding
    the literal only inside a longer word (``quokka`` in ``quokkabuild``)
    never comes back and would be silently dropped from the scan. Under ``-w``
    both sides mean the same thing, and any tokenizer disagreement can only
    over-fetch, which the local scan filters. A regex narrowed on an extracted
    literal stays excluded even under ``-w``, because the searched term is
    then only part of the match: ``foo[0-9]`` matches ``foo1`` as a whole
    word, but searching ``foo`` never returns a file whose only token is
    ``foo1``.

    Args:
        accessor (GitHubAccessor): backend handle.
        index (IndexCacheStore): populated path/size index.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.
        pattern (str | None): the search pattern, or None for -f-only greps.
        fixed_string (bool): True if -F is set.
        recursive (bool): True if -r/-R is set.
        whole_word (bool): True if -w is set; required for push-down.

    Returns:
        tuple[list[PathSpec], int, bool]: resolved file paths, the file count
            in scope (narrowed count when search was used), and whether code
            search actually narrowed the set.
    """
    key = scope_relative_key(paths[0])
    file_count = count_scope_files(await index.entries(), key)
    query = search_query(pattern,
                         fixed_string) if pattern is not None else None
    literal = (pattern is not None
               and is_literal_pattern(pattern, fixed_string))
    use_search = (query is not None and whole_word and literal
                  and should_use_search(
                      recursive=recursive,
                      on_default_branch=(accessor.ref
                                         == accessor.default_branch),
                  ) and file_count > SCOPE_WARN)
    if use_search:
        assert query is not None
        narrowed = await narrow_paths(accessor.config, accessor.owner,
                                      accessor.repo, query, paths)
        if narrowed:
            return narrowed, len(narrowed), True
    resolved = await resolve_glob(accessor, paths, index)
    return resolved, file_count, False
