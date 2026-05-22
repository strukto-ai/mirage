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

from datetime import datetime, timezone

from mirage.accessor.paperclip import PaperclipAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.paperclip.parsing import (MONTH_NAMES, parse_ls_entries,
                                           parse_sql_rows, sql_id_to_fs_id)
from mirage.types import PathSpec

SOURCES = ["arxiv", "biorxiv", "medrxiv", "pmc"]
YEARS = [str(y) for y in range(2020, datetime.now(timezone.utc).year + 1)]
MONTHS = [f"{m:02d}" for m in range(1, 13)]
_PAPER_SUBDIRS = {"sections", "figures", "supplements"}

_SOURCE_DB_NAME = {
    "arxiv": "arxiv",
    "biorxiv": "biorxiv",
    "medrxiv": "medrxiv",
    "pmc": "pmc",
}


def _build_month_sql(source: str, year: str, month: str, limit: int) -> str:
    """Build the SQL query for listing papers in a given month.

    Args:
        source (str): Filesystem source name (biorxiv, medrxiv, pmc).
        year (str): Four-digit year string.
        month (str): Two-digit month string.
        limit (int): Maximum number of rows to return.

    Returns:
        str: SQL query string.
    """
    if source == "pmc":
        month_int = int(month)
        year_int = int(year)
        if month_int == 12:
            next_month = "01"
            next_year = str(year_int + 1)
        else:
            next_month = f"{month_int + 1:02d}"
            next_year = year
        return (f"SELECT pmc_id AS id, title FROM documents "
                f"WHERE source = 'pmc' "
                f"AND received_date >= '{year}-{month}-01' "
                f"AND received_date < '{next_year}-{next_month}-01' "
                f"LIMIT {limit}")
    db_source = _SOURCE_DB_NAME[source]
    month_name = MONTH_NAMES[month]
    return (f"SELECT document_id AS id, title FROM documents "
            f"WHERE source = '{db_source}' "
            f"AND month_year = '{month_name}_{year}' "
            f"LIMIT {limit}")


async def _build_static(
    items: list[str],
    resource_type: str,
    prefix: str,
    key: str,
    index: IndexCacheStore | None,
) -> list[str]:
    """Build a static directory listing and cache it.

    Args:
        items (list[str]): Names to list.
        resource_type (str): Resource type for index entries.
        prefix (str): Mount prefix.
        key (str): Stripped path key.
        index (IndexCacheStore | None): Index cache store.

    Returns:
        list[str]: Full virtual paths.
    """
    virtual_key = prefix + "/" + key if key else prefix or "/"
    entries = []
    names = []
    for item in items:
        entry = IndexEntry(
            id=item,
            name=item,
            resource_type=resource_type,
            vfs_name=item,
        )
        entries.append((item, entry))
        full_path = f"{prefix}/{key}/{item}" if key else f"{prefix}/{item}"
        names.append(full_path)
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def readdir(
    accessor: PaperclipAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    """List directory contents for the Paperclip resource.

    Args:
        accessor (PaperclipAccessor): Paperclip accessor.
        path (PathSpec | str): Resource-relative path.
        index (IndexCacheStore | None): Index cache.
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.directory if path.pattern else path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    if not key:
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        return await _build_static(SOURCES, "paperclip/source", prefix, "",
                                   index)

    parts = key.split("/")

    if len(parts) == 1 and parts[0] in SOURCES:
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        return await _build_static(YEARS, "paperclip/year", prefix, key, index)

    if len(parts) == 2 and parts[0] in SOURCES and parts[1] in YEARS:
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        return await _build_static(MONTHS, "paperclip/month", prefix, key,
                                   index)

    if len(parts) == 3 and parts[0] in SOURCES and parts[1] in YEARS and parts[
            2] in MONTHS:
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        source, year, month = parts
        sql = _build_month_sql(source, year, month,
                               accessor.config.default_limit)
        result = await accessor.execute("sql", f'"{sql}"')
        output = result.get("output", "")
        rows = parse_sql_rows(output)
        entries = []
        names = []
        for row in rows:
            raw_id = row.get("id", "")
            fs_id = sql_id_to_fs_id(raw_id, source)
            entry = IndexEntry(
                id=raw_id,
                name=row.get("title", fs_id),
                resource_type="paperclip/paper",
                vfs_name=fs_id,
            )
            entries.append((fs_id, entry))
            names.append(f"{prefix}/{key}/{fs_id}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    if len(parts) == 4 and parts[0] in SOURCES:
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        paper_id = parts[3]
        result = await accessor.execute("ls", f"/papers/{paper_id}/")
        output = result.get("output", "")
        ls_items = parse_ls_entries(output)
        entries = []
        names = []
        for item in ls_items:
            is_dir = item in _PAPER_SUBDIRS
            rtype = "paperclip/dir" if is_dir else "paperclip/file"
            entry = IndexEntry(
                id=item,
                name=item,
                resource_type=rtype,
                vfs_name=item,
            )
            entries.append((item, entry))
            names.append(f"{prefix}/{key}/{item}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    if len(parts) >= 5 and parts[0] in SOURCES:
        if index is not None:
            listing = await index.list_dir(virtual_key)
            if listing.entries is not None:
                return listing.entries
        paper_id = parts[3]
        sub_path = "/".join(parts[4:])
        result = await accessor.execute("ls",
                                        f"/papers/{paper_id}/{sub_path}/")
        output = result.get("output", "")
        ls_items = parse_ls_entries(output)
        entries = []
        names = []
        for item in ls_items:
            entry = IndexEntry(
                id=item,
                name=item,
                resource_type="paperclip/file",
                vfs_name=item,
            )
            entries.append((item, entry))
            names.append(f"{prefix}/{key}/{item}")
        if index is not None:
            await index.set_dir(virtual_key, entries)
        return names

    return []
