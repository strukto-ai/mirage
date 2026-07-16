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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.notion.pages import get_database
from mirage.core.notion.pathing import split_suffix_id
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type


async def stat(
    accessor: NotionAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path_spec.virtual
    path = path_spec.mount_path

    key = path.strip("/")

    if not key or key in ("pages", "databases"):
        return FileStat(name=key or "/", type=FileType.DIRECTORY)

    parts = key.split("/")

    if parts[-1] == "page.json":
        return FileStat(name="page.json", type=guess_type("page.json"))

    if parts[-1] == "database.json" and len(
            parts) >= 3 and parts[0] == "databases":
        _, database_id = split_suffix_id(parts[-2])
        return FileStat(
            name="database.json",
            type=guess_type("database.json"),
            extra={"database_id": database_id},
        )

    if len(parts) == 2 and parts[0] == "databases":
        _, database_id = split_suffix_id(parts[-1])
        result = await index.get("/" + key)
        if result.entry is not None:
            return FileStat(
                name=result.entry.name,
                type=FileType.DIRECTORY,
                extra={"database_id": database_id},
            )
        database = await get_database(accessor.config, database_id)
        return FileStat(
            name=parts[-1],
            type=FileType.DIRECTORY,
            modified=database.get("last_edited_time"),
            extra={"database_id": database_id},
        )

    if (parts[0] == "pages" and len(parts) >= 2) or (parts[0] == "databases"
                                                     and len(parts) >= 3):
        _, page_id = split_suffix_id(parts[-1])
        result = await index.get("/" + key)
        if result.entry is not None:
            return FileStat(
                name=result.entry.name,
                type=FileType.DIRECTORY,
                modified=result.entry.remote_time or None,
                extra={"page_id": page_id},
            )
        return FileStat(
            name=parts[-1],
            type=FileType.DIRECTORY,
            extra={"page_id": page_id},
        )

    raise enoent(virtual)
