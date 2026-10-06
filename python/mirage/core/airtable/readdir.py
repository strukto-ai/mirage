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

from mirage.accessor.airtable import AirtableAccessor
from mirage.cache.index import IndexEntry
from mirage.core.airtable.client import list_bases, list_tables
from mirage.core.airtable.normalize import (
    as_rows,
    normalize_base,
    normalize_table,
    to_json_bytes,
)
from mirage.core.airtable.pathing import (
    base_dirname,
    table_dirname,
    view_filename,
)
from mirage.core.airtable.scope import detect_scope
from mirage.core.hierarchy.readdir import DirListing, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.errors.fs import enoent

Listing = list[tuple[str, IndexEntry]]


def _base_row(entry: IndexEntry) -> dict[str, Any]:
    # The base listing row base.json renders, rebuilt from the directory
    # entry that listing wrote, so its size needs no second call.
    return {
        "id": entry.id,
        "name": entry.name,
        "permissionLevel": entry.extra.get("permission_level"),
    }


def table_children(table: dict[str, Any], base_id: str) -> Listing:
    """A table directory's contents, all known from the base schema.

    records.jsonl stays size-unknown: its bytes are the table's records,
    which only a paged read produces.

    Args:
        table (dict[str, Any]): a schema table.
        base_id (str): the base holding it.
    """
    table_id = table["id"]
    return [
        (
            "table.json",
            IndexEntry(
                id=table_id,
                name="table.json",
                resource_type="airtable/table_json",
                vfs_name="table.json",
                size=len(to_json_bytes(normalize_table(table, base_id))),
            ),
        ),
        (
            "records.jsonl",
            IndexEntry(
                id=table_id,
                name="records.jsonl",
                resource_type="airtable/records",
                vfs_name="records.jsonl",
            ),
        ),
        (
            "views",
            IndexEntry(
                id=table_id,
                name="views",
                resource_type="airtable/views_dir",
                vfs_name="views",
            ),
        ),
    ]


def view_children(table: dict[str, Any]) -> Listing:
    """A table's saved views, one size-unknown .jsonl file each.

    Args:
        table (dict[str, Any]): a schema table.
    """
    entries: Listing = []
    for view in as_rows(table.get("views")):
        filename = view_filename(view)
        entries.append(
            (
                filename,
                IndexEntry(
                    id=view["id"],
                    name=view.get("name") or view["id"],
                    resource_type="airtable/view",
                    vfs_name=filename,
                ),
            )
        )
    return entries


async def _list_bases_dir(
    accessor: AirtableAccessor, match: ScopeMatch
) -> Listing:
    entries: Listing = []
    for base in await list_bases(accessor):
        dirname = base_dirname(base)
        entries.append(
            (
                dirname,
                IndexEntry(
                    id=base["id"],
                    name=base.get("name") or base["id"],
                    resource_type="airtable/base",
                    vfs_name=dirname,
                    extra={
                        "permission_level": base.get("permissionLevel"),
                    },
                ),
            )
        )
    return entries


async def _list_base(
    accessor: AirtableAccessor, match: ScopeMatch, entry: IndexEntry
) -> DirListing:
    # One schema call answers the base AND every table directory and
    # views directory under it, so they are seeded rather than refetched.
    base_id = match.slots["base_id"]
    tables = await list_tables(accessor, base_id)
    base_json = to_json_bytes(normalize_base(_base_row(entry), tables))
    entries: Listing = [
        (
            "base.json",
            IndexEntry(
                id=base_id,
                name="base.json",
                resource_type="airtable/base_json",
                vfs_name="base.json",
                size=len(base_json),
            ),
        )
    ]
    seeds: dict[str, Listing] = {}
    for table in tables:
        dirname = table_dirname(table)
        entries.append(
            (
                dirname,
                IndexEntry(
                    id=table["id"],
                    name=table.get("name") or table["id"],
                    resource_type="airtable/table",
                    vfs_name=dirname,
                ),
            )
        )
        seeds[dirname] = table_children(table, base_id)
        seeds[f"{dirname}/views"] = view_children(table)
    return DirListing(entries=entries, seeds=seeds)


async def schema_table(
    accessor: AirtableAccessor, match: ScopeMatch
) -> dict[str, Any]:
    """The schema of the table a path names, from its base's schema.

    Args:
        accessor (AirtableAccessor): the account.
        match (ScopeMatch): a match carrying base_id and table_id.

    Raises:
        FileNotFoundError: the base no longer holds that table.
    """
    table_id = match.slots["table_id"]
    for table in await list_tables(accessor, match.slots["base_id"]):
        if table.get("id") == table_id:
            return table
    raise enoent(match.vfs_path)


async def _list_table(
    accessor: AirtableAccessor, match: ScopeMatch, entry: IndexEntry
) -> Listing:
    table = await schema_table(accessor, match)
    return table_children(table, match.slots["base_id"])


async def _list_views(
    accessor: AirtableAccessor, match: ScopeMatch, entry: IndexEntry
) -> Listing:
    return view_children(await schema_table(accessor, match))


readdir = make_readdir(
    detect_scope,
    listers={
        "bases": _list_bases_dir,
    },
    entry_listers={
        "base": _list_base,
        "table": _list_table,
        "views": _list_views,
    },
    static_root=("bases",),
)
