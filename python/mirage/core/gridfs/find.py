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

import re
from typing import Any

from mirage.accessor.gridfs import GridFSAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.core.gridfs._client import (_prefix, _strip_prefix, files_coll,
                                        iter_latest, prefix_query)
from mirage.types import PathSpec


def glob_regex(pattern: str) -> str | None:
    """Translate a find -name glob into an anchored-safe regex fragment.

    Args:
        pattern (str): Glob pattern (``*``, ``?`` supported).

    Returns:
        str | None: Regex fragment matching one path segment, or None when
        the pattern uses character classes we do not translate (caller
        falls back to the unpushed prefix query; client-side ``keep()``
        still applies the exact semantics).
    """
    if "[" in pattern or "]" in pattern:
        return None
    parts: list[str] = []
    for ch in pattern:
        if ch == "*":
            parts.append("[^/]*")
        elif ch == "?":
            parts.append("[^/]")
        else:
            parts.append(re.escape(ch))
    return "".join(parts)


def build_query(pfx: str, name: str | None, iname: str | None,
                type: str | None, min_size: int | None, max_size: int | None,
                pushdown: bool) -> dict[str, Any]:
    """Build the fs.files query, pushing filters server-side when exact.

    Every condition is a superset of the GNU semantics (directory markers
    always pass the size condition, unpushable globs fall back to the
    prefix scan), so the client-side ``keep()`` pass stays authoritative.

    Args:
        pfx (str): Key prefix of the start directory ("" for root).
        name (str | None): -name glob.
        iname (str | None): -iname glob.
        type (str | None): "f" or "d".
        min_size (int | None): Inclusive lower size bound.
        max_size (int | None): Inclusive upper size bound.
        pushdown (bool): False when a complex predicate tree is present;
            only the prefix condition is used then.
    """
    conds: list[dict[str, Any]] = []
    base = prefix_query(pfx)
    if base:
        conds.append(base)
    if pushdown:
        escaped = re.escape(pfx)
        for pat, options in ((name, ""), (iname, "i")):
            if pat is None:
                continue
            rx = glob_regex(pat)
            if rx is None:
                continue
            regex: dict[str, Any] = {
                "$regex": f"^{escaped}(.*/)?{rx}/?$",
            }
            if options:
                regex["$options"] = options
            conds.append({"filename": regex})
        if type == "f":
            conds.append({"filename": {"$not": {"$regex": "/$"}}})
        elif type == "d":
            conds.append({"filename": {"$regex": "/$"}})
        if min_size is not None or max_size is not None:
            size_cond: dict[str, Any] = {}
            if min_size is not None:
                size_cond["$gte"] = min_size
            if max_size is not None:
                size_cond["$lte"] = max_size
            # Directory markers ride through; the client-side
            # dirs-count-as-0 rule decides their fate.
            conds.append({
                "$or": [
                    {
                        "length": size_cond
                    },
                    {
                        "filename": {
                            "$regex": "/$"
                        }
                    },
                ]
            })
    if not conds:
        return {}
    if len(conds) == 1:
        return conds[0]
    return {"$and": conds}


async def find(
    accessor: GridFSAccessor,
    path_spec: PathSpec,
    name: str | None = None,
    type: str | None = None,
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
    """Find files under a prefix, pushing filters into the fs.files query.

    Unlike object-store backends that must page through every key, GridFS
    metadata lives in an ordinary MongoDB collection, so -name/-iname,
    -type, and -size narrow server-side; the shared ``keep()`` evaluation
    still runs on the results, so semantics match the other backends
    exactly.

    Args:
        accessor (GridFSAccessor): GridFS accessor.
        path_spec (PathSpec): Prefix path.
        name (str | None): Glob pattern to match entry name.
        type (str | None): "f" (file) or "d" (directory).
        min_size (int | None): Minimum file size.
        max_size (int | None): Maximum file size.
        maxdepth (int | None): Maximum directory depth.
        name_exclude (str | None): Glob pattern to exclude.
        or_names (list[str] | None): Alternative name patterns (OR logic).
        mtime_min (float | None): Accepted for signature parity but not
            applied: synthetic directories carry no mtime, so filtering
            would drop every directory and diverge from the other
            backends and the shared integ truth.
        mtime_max (float | None): See mtime_min.
        iname (str | None): Case-insensitive glob pattern for basename.
        path_pattern (str | None): Glob pattern to match full path.
        mindepth (int | None): Minimum depth to include.
    """
    start_name = start_basename(path_spec)
    path = path_spec.mount_path
    config = accessor.config
    pfx = _prefix(path, config)
    results: list[str] = []
    pushdown = (tree is None and name_exclude is None and or_names is None
                and path_pattern is None and not empty)
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    query = build_query(pfx, name, iname, type, min_size, max_size, pushdown)
    narrowed = query != prefix_query(pfx)
    saw_descendant = False
    dir_marker_seen = False
    async for doc in iter_latest(accessor, query):
        key = doc["filename"]
        if key == pfx:
            dir_marker_seen = True
            continue
        saw_descendant = True
        is_dir = key.endswith("/")
        norm_key = key[:-1] if is_dir else key
        relative = norm_key[len(pfx):]
        depth = relative.count("/") + 1
        if maxdepth is not None and depth > maxdepth:
            continue
        entry_name = norm_key.rsplit("/", 1)[-1]
        full_path = "/" + _strip_prefix(norm_key, config)
        size = doc["length"]
        is_empty = (None if not empty else
                    (size == 0 if not is_dir else False))
        entry = FindEntry(key=full_path,
                          name=entry_name,
                          kind="d" if is_dir else "f",
                          depth=depth,
                          is_empty=is_empty)
        if not keep(entry, tree, mindepth):
            continue
        if min_size is not None or max_size is not None:
            # Directories count as size 0 for -size (deliberate GNU
            # divergence).
            effective = 0 if is_dir else size
            if min_size is not None and effective < min_size:
                continue
            if max_size is not None and effective > max_size:
                continue
        results.append(full_path)
    if narrowed and not (saw_descendant or dir_marker_seen):
        # The narrowed query may have excluded every doc under a prefix
        # that does exist; probe so the start path still emits.
        probe = await files_coll(accessor).find_one(prefix_query(pfx),
                                                    projection={"_id": 1})
        saw_descendant = probe is not None
    stripped = path.strip("/")
    if saw_descendant or dir_marker_seen:
        root_key = "/" + stripped if stripped else "/"
        emit_start_path(results,
                        root_key,
                        start_name,
                        kind="d",
                        is_empty=False if empty else None,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        min_size=min_size,
                        max_size=max_size)
    return sorted(results)
