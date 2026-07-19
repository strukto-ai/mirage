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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.box.io import resolve_glob
from mirage.commands.builtin.grep_helper import (BINARY_EXTENSIONS,
                                                 get_extension, search_query)
from mirage.core.box.search import narrow_paths
from mirage.core.box.stat import stat as box_stat
from mirage.types import FileType, PathSpec


async def _all_directories(
    accessor: BoxAccessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
) -> bool:
    """Whether every scope operand stats as a directory.

    File operands keep the exact single-file output shape (no walk-style
    labels), and missing operands must surface the walk's error message,
    so both fall back to the generic scan.

    Args:
        accessor (BoxAccessor): backend handle.
        index (IndexCacheStore): index consulted before the folder API.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.
    """
    for p in paths:
        try:
            s = await box_stat(accessor, p, index)
        except (OSError, ValueError):
            return False
        if s.type != FileType.DIRECTORY:
            return False
    return True


async def narrow_scope(
    accessor: BoxAccessor,
    index: IndexCacheStore,
    paths: list[PathSpec],
    pattern: str | None,
    *,
    fixed_string: bool,
    recursive: bool,
    exact_file_set: bool,
) -> tuple[list[PathSpec], bool]:
    """Resolve grep/rg scope paths, narrowing via Box content search.

    Push-down needs every gate to hold: the mount opted in via
    ``content_search``, the scan is recursive, a single-line literal can be
    pushed down (regex patterns narrow on an extracted required literal and
    stay exact because the caller still scans the regex locally), the output
    mode tolerates a narrowed-superset file set (``exact_file_set`` covers
    flags like -v that must see every file), and every scope operand is a
    directory. There is no scope-size gate: one search call plus targeted
    downloads beats a readdir-walk-plus-download-everything scan at every
    scope size. An empty search result still falls back to the full scan
    because Box's search index lags recent writes.

    Binary-extension candidates are dropped from the narrowed set because the
    recursive walk it replaces skips them.

    Args:
        accessor (BoxAccessor): backend handle.
        index (IndexCacheStore): index for the glob-resolution fallback.
        paths (list[PathSpec]): scope paths, possibly mount-prefixed.
        pattern (str | None): the search pattern, or None for -f-only runs.
        fixed_string (bool): True if -F is set.
        recursive (bool): True if the scan walks directories.
        exact_file_set (bool): True when the output mode must see every file
            in scope, forcing the full walk.

    Returns:
        tuple[list[PathSpec], bool]: resolved paths and whether search
            narrowed the set. A narrowed set may be empty (every candidate was
            binary); callers must not treat that as a stdin run.
    """
    query = (search_query(pattern, fixed_string)
             if pattern is not None and "\n" not in pattern else None)
    use_search = (query is not None and recursive and not exact_file_set
                  and accessor.config.content_search
                  and await _all_directories(accessor, index, paths))
    if use_search:
        assert query is not None
        narrowed = await narrow_paths(accessor, query, paths)
        if narrowed:
            kept = [
                p for p in narrowed
                if get_extension(p.virtual) not in BINARY_EXTENSIONS
            ]
            return kept, True
    resolved = await resolve_glob(accessor, paths, index)
    return resolved, False
