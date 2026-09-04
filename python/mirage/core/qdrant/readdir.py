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
from typing import Any

from mirage.accessor.qdrant import QdrantAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.probe import ReaddirFn
from mirage.core.hierarchy.readdir import (DirListing, Listed, Lister,
                                           make_readdir)
from mirage.core.hierarchy.scope import ROOT, ScopeMatch
from mirage.core.qdrant.fields import field_value, group_name, row_stem
from mirage.core.qdrant.query import (distinct_values, list_tables,
                                      rows_matching, table_exists)
from mirage.core.qdrant.render import blob_bytes, render_json, render_text
from mirage.core.qdrant.scope import detect_for, filters_of, table_of
from mirage.resource.qdrant.config import QdrantConfig
from mirage.types import JsonValue, PathSpec
from mirage.utils.glob_walk import (glob_prefix, glob_stem_prefix,
                                    has_glob_prefix)

logger = logging.getLogger(__name__)

GROUP_TYPE = "qdrant/group"


def _dir_entry(name: str) -> IndexEntry:
    return IndexEntry(id=name,
                      name=name,
                      resource_type=GROUP_TYPE,
                      vfs_name=name)


def _blob_size(value: JsonValue) -> int | None:
    # A payload whose blob column holds something undecodable must not take
    # the whole listing down with it: leave the size unknown and let read()
    # raise the same error it always did.
    try:
        return len(blob_bytes(value))
    except ValueError as exc:
        logger.debug("qdrant: unsizeable blob value (%s); size stays unknown",
                     exc)
        return None


def _row_entries(rows: list[dict[str, Any]],
                 config: QdrantConfig) -> list[tuple[str, IndexEntry]]:
    # The scroll already carries every payload, so each file's exact
    # rendered size is free here; stat serves it from the index instead of
    # refetching one row per file.
    entries: list[tuple[str, IndexEntry]] = []
    for row in rows:
        rid = str(row[config.id_field])
        stem = row_stem(row, config)
        entries.append((f"{stem}.json",
                        IndexEntry(
                            id=rid,
                            name=f"{stem}.json",
                            resource_type="qdrant/row_json",
                            vfs_name=f"{stem}.json",
                            size=len(render_json(row, config)),
                        )))
        if config.text_field and field_value(row,
                                             config.text_field) is not None:
            entries.append((f"{stem}.txt",
                            IndexEntry(
                                id=rid,
                                name=f"{stem}.txt",
                                resource_type="qdrant/row_text",
                                vfs_name=f"{stem}.txt",
                                size=len(render_text(row, config)),
                            )))
        if config.blob_field and field_value(row,
                                             config.blob_field) is not None:
            blob_name = f"{stem}.{config.blob_ext}"
            entries.append(
                (blob_name,
                 IndexEntry(
                     id=rid,
                     name=blob_name,
                     resource_type="qdrant/row_blob",
                     vfs_name=blob_name,
                     size=_blob_size(field_value(row, config.blob_field)),
                 )))
    return entries


def _row_prefix(pattern: str | None, config: QdrantConfig) -> str:
    """The point-id prefix a leaf glob narrows the scroll to.

    A leaf is named ``<point_id>`` plus whichever suffix the renderer
    gave it, and only the id half is a prefix the scroll can test.

    Args:
        pattern (str | None): the glob the line typed, or None.
        config (QdrantConfig): the mount's config, for the suffixes.
    """
    suffixes = [".json"]
    if config.text_field:
        suffixes.append(".txt")
    if config.blob_field:
        suffixes.append(f".{config.blob_ext}")
    return glob_stem_prefix(pattern, suffixes)


async def _resolved_filters(accessor: QdrantAccessor, table: str,
                            filters: dict[str, str]) -> dict[str, str] | None:
    """Resolve basename-rendered group segments back to payload values."""
    resolved: dict[str, str] = {}
    for column, value in filters.items():
        if column not in accessor.config.basename_fields:
            resolved[column] = value
            continue
        values = await distinct_values(accessor, table, column, resolved,
                                       accessor.config.max_rows, value, True)
        matches = [
            raw for raw in values if group_name(raw, basename=True) == value
        ]
        if not matches:
            return None
        if len(matches) > 1:
            raise ValueError(
                f"qdrant: basename collision for {column!r}: {value!r}")
        resolved[column] = matches[0]
    return resolved


async def _children(accessor: QdrantAccessor,
                    match: ScopeMatch) -> Listed | None:
    config = accessor.config
    table = table_of(config, match)
    pattern = match.pattern
    if not await table_exists(accessor, table):
        return None
    filters = await _resolved_filters(accessor, table,
                                      filters_of(config, match))
    if filters is None:
        return None
    depth = len(filters)
    if depth < len(config.group_by):
        display_prefix = glob_prefix(pattern)
        basename = config.group_by[depth] in config.basename_fields
        names = await distinct_values(accessor, table, config.group_by[depth],
                                      filters, config.max_rows, display_prefix,
                                      basename)
        rendered = [group_name(name, basename=basename) for name in names]
        if display_prefix:
            rendered = [
                name for name in rendered if name.startswith(display_prefix)
            ]
        if len(rendered) != len(set(rendered)):
            raise ValueError(
                "qdrant: basename_fields produced a path collision")
        return DirListing(entries=[(name, _dir_entry(name))
                                   for name in rendered],
                          partial=bool(display_prefix))
    prefix = _row_prefix(pattern, config)
    rows = await rows_matching(accessor, table, filters, config.max_rows,
                               prefix)
    return DirListing(entries=_row_entries(rows, config), partial=bool(prefix))


async def _list_root(accessor: QdrantAccessor,
                     match: ScopeMatch) -> Listed | None:
    config = accessor.config
    if not config.collection:
        # Collection names come from the catalog, not from a capped
        # scroll, so a glob here has nothing to narrow.
        return [(name, _dir_entry(name))
                for name in await list_tables(accessor)]
    return await _children(accessor, match)


async def _list_group(accessor: QdrantAccessor,
                      match: ScopeMatch) -> Listed | None:
    return await _children(accessor, match)


LISTERS: dict[str, Lister[QdrantAccessor]] = {
    ROOT: _list_root,
    "group": _list_group,
}

PATTERN_KINDS = {ROOT: has_glob_prefix, "group": has_glob_prefix}


def _build(accessor: QdrantAccessor) -> ReaddirFn[QdrantAccessor]:
    return make_readdir(detect_for(accessor),
                        listers=LISTERS,
                        pattern_kinds=PATTERN_KINDS)


readdir_for = per_accessor(_build)


async def readdir(
    accessor: QdrantAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    return await readdir_for(accessor)(accessor, path, index)
