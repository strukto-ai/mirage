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
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import entry_stat
from mirage.errors.fs import enoent
from mirage.types import ContentType, DirListing, FileStat, FileType

BASE = entry_stat("base_id", FileType.DIRECTORY)
BASE_JSON = entry_stat("base_id", ContentType.JSON)
TABLE = entry_stat("table_id", FileType.DIRECTORY)
TABLE_JSON = entry_stat("table_id", ContentType.JSON)
RECORDS = entry_stat("table_id", ContentType.TEXT)
VIEWS = entry_stat("table_id", FileType.DIRECTORY)
VIEW = entry_stat("view_id", ContentType.TEXT)


def _base_row(entry: FileStat) -> dict[str, Any]:
    # The base listing row base.json renders, rebuilt from the directory's
    # row that listing wrote, so its size needs no second call.
    return {
        "id": entry.extra.get("base_id"),
        "name": entry.extra.get("base_name"),
        "permissionLevel": entry.extra.get("permission_level"),
    }


def table_children(table: dict[str, Any], base_id: str) -> list[FileStat]:
    """A table directory's contents, all known from the base schema.

    records.jsonl stays size-unknown: its bytes are the table's records,
    which only a paged read produces.

    Args:
        table (dict[str, Any]): a schema table.
        base_id (str): the base holding it.
    """
    table_id = table["id"]
    return [
        TABLE_JSON(
            "table.json",
            table_id,
            size=len(to_json_bytes(normalize_table(table, base_id))),
        ),
        RECORDS("records.jsonl", table_id),
        VIEWS("views", table_id),
    ]


def view_children(table: dict[str, Any]) -> list[FileStat]:
    """A table's saved views, one size-unknown .jsonl file each.

    Args:
        table (dict[str, Any]): a schema table.
    """
    return [
        VIEW(view_filename(view), view["id"])
        for view in as_rows(table.get("views"))
    ]


async def _list_bases_dir(
    accessor: AirtableAccessor, match: ScopeMatch
) -> list[FileStat]:
    return [
        BASE(
            base_dirname(base),
            base["id"],
            extra={
                "base_name": base.get("name") or base["id"],
                "permission_level": base.get("permissionLevel"),
            },
        )
        for base in await list_bases(accessor)
    ]


async def _list_base(
    accessor: AirtableAccessor, match: ScopeMatch, entry: FileStat
) -> DirListing:
    # One schema call answers the base AND every table directory and
    # views directory under it, so they are seeded rather than refetched.
    base_id = match.slots["base_id"]
    tables = await list_tables(accessor, base_id)
    base_json = to_json_bytes(normalize_base(_base_row(entry), tables))
    rows = [BASE_JSON("base.json", base_id, size=len(base_json))]
    seeds: dict[str, list[FileStat]] = {}
    for table in tables:
        dirname = table_dirname(table)
        rows.append(TABLE(dirname, table["id"]))
        seeds[dirname] = table_children(table, base_id)
        seeds[f"{dirname}/views"] = view_children(table)
    return DirListing(entries=rows, seeds=seeds)


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
    accessor: AirtableAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    table = await schema_table(accessor, match)
    return table_children(table, match.slots["base_id"])


async def _list_views(
    accessor: AirtableAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
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
