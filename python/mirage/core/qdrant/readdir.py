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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import DirListing, Listed
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.qdrant.naming import group_name, row_stem
from mirage.core.qdrant.payload import field_value
from mirage.core.qdrant.query import (
    distinct_values,
    resolve_group,
    rows_matching,
    table_exists,
)
from mirage.core.qdrant.render import render_json, render_text
from mirage.core.qdrant.types import QdrantRow
from mirage.core.vector.read import blob_bytes
from mirage.core.vector.readdir import dir_entry
from mirage.core.vector.scope import filters_of, table_of
from mirage.types import JsonValue
from mirage.utils.glob_walk import glob_prefix, glob_stem_prefix
from mirage.vfs.qdrant.config import QdrantConfig

logger = logging.getLogger(__name__)


def _blob_size(value: JsonValue) -> int | None:
    # A payload whose blob column holds something undecodable must not take
    # the whole listing down with it: leave the size unknown and let read()
    # raise the same error it always did.
    try:
        return len(blob_bytes(value))
    except ValueError as exc:
        logger.debug(
            "qdrant: unsizeable blob value (%s); size stays unknown", exc
        )
        return None


def _row_entries(
    rows: list[QdrantRow], config: QdrantConfig
) -> list[tuple[str, IndexEntry]]:
    # The scroll already carries every payload, so each file's exact
    # rendered size is free here; stat serves it from the index instead of
    # refetching one row per file.
    entries: list[tuple[str, IndexEntry]] = []
    for row in rows:
        rid = str(row[config.id_field])
        stem = row_stem(row, config)
        entries.append(
            (
                f"{stem}.json",
                IndexEntry(
                    id=rid,
                    name=f"{stem}.json",
                    resource_type="qdrant/row_json",
                    vfs_name=f"{stem}.json",
                    size=len(render_json(row, config)),
                ),
            )
        )
        if (
            config.text_field
            and field_value(row, config.text_field) is not None
        ):
            entries.append(
                (
                    f"{stem}.txt",
                    IndexEntry(
                        id=rid,
                        name=f"{stem}.txt",
                        resource_type="qdrant/row_text",
                        vfs_name=f"{stem}.txt",
                        size=len(render_text(row, config)),
                    ),
                )
            )
        if (
            config.blob_field
            and field_value(row, config.blob_field) is not None
        ):
            blob_name = f"{stem}.{config.blob_ext}"
            entries.append(
                (
                    blob_name,
                    IndexEntry(
                        id=rid,
                        name=blob_name,
                        resource_type="qdrant/row_blob",
                        vfs_name=blob_name,
                        size=_blob_size(field_value(row, config.blob_field)),
                    ),
                )
            )
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


async def _resolved_filters(
    accessor: QdrantAccessor, table: str, filters: dict[str, str]
) -> dict[str, str] | None:
    """Resolve basename-rendered group segments back to payload values."""
    resolved: dict[str, str] = {}
    for column, value in filters.items():
        if column not in accessor.config.basename_fields:
            resolved[column] = value
            continue
        sources = await resolve_group(
            accessor, table, column, resolved, value, True
        )
        if not sources:
            return None
        if len(sources) > 1:
            raise ValueError(
                f"qdrant: basename collision for {column!r}: {value!r}"
            )
        resolved[column] = sources[0]
    return resolved


async def children(
    accessor: QdrantAccessor, match: ScopeMatch
) -> Listed | None:
    """The entries under a collection or a group.

    Args:
        accessor (QdrantAccessor): the mount's accessor.
        match (ScopeMatch): the directory's match.
    """
    config = accessor.config
    table = table_of(config.collection, match)
    pattern = match.pattern
    if not await table_exists(accessor, table):
        return None
    filters = await _resolved_filters(
        accessor, table, filters_of(config.group_by, match)
    )
    if filters is None:
        return None
    depth = len(filters)
    if depth < len(config.group_by):
        display_prefix = glob_prefix(pattern)
        basename = config.group_by[depth] in config.basename_fields
        names = await distinct_values(
            accessor,
            table,
            config.group_by[depth],
            filters,
            config.max_rows,
            display_prefix,
            basename,
        )
        rendered = [group_name(name, basename=basename) for name in names]
        if display_prefix:
            rendered = [
                name for name in rendered if name.startswith(display_prefix)
            ]
        if len(rendered) != len(set(rendered)):
            raise ValueError(
                "qdrant: basename_fields produced a path collision"
            )
        return DirListing(
            entries=[(name, dir_entry("qdrant", name)) for name in rendered],
            partial=bool(display_prefix),
            window=True,
        )
    prefix = _row_prefix(pattern, config)
    rows = await rows_matching(
        accessor, table, filters, config.max_rows, prefix
    )
    # Read up to max_rows, so a row outside the head of the collection is
    # not gone because a listing no longer names it.
    return DirListing(
        entries=_row_entries(rows, config), partial=bool(prefix), window=True
    )
