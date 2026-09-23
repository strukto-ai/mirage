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

from typing import Any

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.codec import PATH_SAFE
from mirage.core.hierarchy.probe import ReaddirFn
from mirage.core.hierarchy.readdir import (DirListing, Listed, Lister,
                                           make_readdir)
from mirage.core.hierarchy.scope import ROOT, ScopeMatch
from mirage.core.lancedb.query import (ValueTest, distinct_values, list_tables,
                                       rows_matching, table_columns,
                                       table_exists)
from mirage.core.lancedb.render import render_card
from mirage.core.lancedb.scope import detect_for, filters_of, table_of
from mirage.types import PathSpec
from mirage.utils.glob_walk import (glob_prefix, glob_stem_prefix,
                                    has_glob_prefix)
from mirage.vfs.lancedb.config import LanceDBConfig

GROUP_TYPE = "lancedb/group"


def _dir_entry(name: str) -> IndexEntry:
    return IndexEntry(id=name,
                      name=name,
                      resource_type=GROUP_TYPE,
                      vfs_name=name)


def _row_entries(rows: list[dict[str, Any]],
                 config: LanceDBConfig) -> list[tuple[str, IndexEntry]]:
    # The widened select carries every rendered column, so each card's exact
    # size is free here; blob values are deliberately not fetched at listing
    # time, so blob entries stay size-unknown and stat renders them itself.
    entries: list[tuple[str, IndexEntry]] = []
    for row in rows:
        rid = str(row[config.id_column])
        entries.append((f"{rid}.md",
                        IndexEntry(
                            id=rid,
                            name=f"{rid}.md",
                            resource_type="lancedb/row_card",
                            vfs_name=f"{rid}.md",
                            size=len(render_card(row, config)),
                        )))
        if config.blob_column:
            blob_name = f"{rid}.{config.blob_ext}"
            entries.append((blob_name,
                            IndexEntry(
                                id=rid,
                                name=blob_name,
                                resource_type="lancedb/row_blob",
                                vfs_name=blob_name,
                            )))
    return entries


def _rendered_prefix_test(prefix: str) -> ValueTest:
    """Keep values whose rendered name starts with a glob's literal head.

    Args:
        prefix (str): the head, spelled in rendered names.
    """

    def keep(value: str) -> bool:
        return PATH_SAFE.encode(value).startswith(prefix)

    return keep


def _row_prefix(pattern: str | None, config: LanceDBConfig) -> str:
    """The row-id prefix a leaf glob narrows the row query to.

    A leaf is named ``<row_id>`` plus whichever suffix the renderer gave
    it, and only the id half is a prefix the query can test.

    Args:
        pattern (str | None): the glob the line typed, or None.
        config (LanceDBConfig): the mount's config, for the suffixes.
    """
    suffixes = [".md"]
    if config.blob_column:
        suffixes.append(f".{config.blob_ext}")
    return glob_stem_prefix(pattern, suffixes)


async def _children(accessor: LanceDBAccessor,
                    match: ScopeMatch) -> Listed | None:
    config = accessor.config
    table = table_of(config, match)
    filters = filters_of(config, match)
    pattern = match.pattern
    if not await table_exists(accessor, table):
        return None
    depth = len(filters)
    if depth < len(config.group_by):
        display_prefix = glob_prefix(pattern)
        # Values render path-safe, so a glob's head is spelled in rendered
        # names: the query takes the value prefix the head stands for, which
        # loses nothing, and the cap counts the renderings that really start
        # with the head, so a head no value prefix spells (the escape lead
        # alone) still reaches past the rows at the head of the table.
        values = await distinct_values(
            accessor, table, config.group_by[depth], filters, config.max_rows,
            PATH_SAFE.prefix_value(display_prefix),
            _rendered_prefix_test(display_prefix) if display_prefix else None)
        names = sorted(map(PATH_SAFE.encode, values))
        return DirListing(entries=[(name, _dir_entry(name)) for name in names],
                          partial=bool(display_prefix))
    # Select every column except the vector and blob ones (schema order, so
    # the projected rows render byte-identically to the full rows read()
    # fetches). Still one data query; the schema lookup is local metadata on
    # the already-opened table.
    columns = [
        c for c in await table_columns(accessor, table)
        if c != config.vector_column and c != config.blob_column
    ]
    prefix = _row_prefix(pattern, config)
    rows = await rows_matching(accessor, table, filters, columns,
                               config.max_rows, config.id_column, prefix)
    return DirListing(entries=_row_entries(rows, config), partial=bool(prefix))


async def _list_root(accessor: LanceDBAccessor,
                     match: ScopeMatch) -> Listed | None:
    config = accessor.config
    if not config.table:
        # Table names come from the catalog, not from a capped query, so
        # a glob here has nothing to narrow.
        return [(name, _dir_entry(name))
                for name in await list_tables(accessor)]
    return await _children(accessor, match)


async def _list_group(accessor: LanceDBAccessor,
                      match: ScopeMatch) -> Listed | None:
    return await _children(accessor, match)


LISTERS: dict[str, Lister[LanceDBAccessor]] = {
    ROOT: _list_root,
    "group": _list_group,
}

PATTERN_KINDS = {ROOT: has_glob_prefix, "group": has_glob_prefix}


def _build(accessor: LanceDBAccessor) -> ReaddirFn[LanceDBAccessor]:
    return make_readdir(detect_for(accessor),
                        listers=LISTERS,
                        pattern_kinds=PATTERN_KINDS)


readdir_for = per_accessor(_build)


async def readdir(
    accessor: LanceDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    return await readdir_for(accessor)(accessor, path, index)
