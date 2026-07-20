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

from mirage.accessor.history import HistoryAccessor
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               keep)
from mirage.core.history.read import VIEW_KEYS, VIEW_NAME, read
from mirage.types import FindType, PathSpec


async def find(
    accessor: HistoryAccessor,
    path: PathSpec,
    name: str | None = None,
    type: FindType | str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
) -> list[str]:
    """find_core over the single-file view: match the view or nothing.

    The view is one virtual file at depth 0 of the mount. Predicates
    are evaluated through the shared ``build_tree``/``keep`` machinery,
    so an expression ``tree`` (``-o``/``-not``/...) and the flag kwargs
    behave identically to the real-tree backends.

    Args:
        accessor (HistoryAccessor): Accessor holding the recorder.
        path (PathSpec): Search root; only the view file resolves.
        name (str | None): fnmatch pattern on the file name.
        type (FindType | str | None): Type filter; "d" never matches.
        min_size (int | None): Minimum rendered size in bytes.
        max_size (int | None): Maximum rendered size in bytes.
        maxdepth (int | None): Excludes the view only when negative.
        name_exclude (str | None): `-not -name` pattern.
        or_names (list[str] | None): `-o -name` alternatives.
        iname (str | None): Case-insensitive name pattern.
        path_pattern (str | None): fnmatch pattern on the full path.
        mindepth (int | None): Filters out the view when > 0.
        empty (bool): `-empty`; matches only a 0-byte rendered view.
        tree (PredNode | None): Pre-built predicate tree; built from
            the flag kwargs when not given.

    Returns:
        list[str]: The view path relative to the mount, or empty.
    """
    key = path.mount_path if isinstance(path, PathSpec) else path
    if key.strip("/") not in VIEW_KEYS:
        raise FileNotFoundError(key)
    if maxdepth is not None and maxdepth < 0:
        return []
    is_empty: bool | None = None
    if min_size is not None or max_size is not None or empty:
        size = len(await read(accessor, path, index=NULL_INDEX))
        if min_size is not None and size < min_size:
            return []
        if max_size is not None and size > max_size:
            return []
        is_empty = size == 0
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    full = path.virtual if isinstance(path, PathSpec) else path
    entry = FindEntry(key=full,
                      name=VIEW_NAME,
                      kind="f",
                      depth=0,
                      is_empty=is_empty)
    if not keep(entry, tree, mindepth):
        return []
    return [""]
