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
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.notion.normalize import page_segment_name
from mirage.core.notion.resolve import resolve_row
from mirage.core.notion.scope import detect_scope
from mirage.errors.fs import enoent
from mirage.types import ContentType, FileStat, FileType, PathSpec


async def _row_stat(
    accessor: NotionAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> FileStat:
    # No listing names a row: its data source lists it as a line of
    # rows.jsonl, so a row proves itself against the data source the
    # mount hands as its parent, once; the mount hands what it proved.
    if entry is not None:
        return entry
    if parent is None:
        raise enoent(path.virtual)
    page = await resolve_row(accessor, match, path.virtual)
    return FileStat(
        name=page_segment_name(page),
        type=FileType.DIRECTORY,
        modified=page.get("last_edited_time") or None,
        extra={"page_id": page.get("id", "")},
    )


async def _row_json_stat(
    accessor: NotionAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> FileStat:
    if parent is None:
        raise enoent(path.virtual)
    return FileStat(
        name="page.json", type=FileType.FILE, content=ContentType.JSON
    )


stat = make_stat(
    detect_scope,
    overrides={"row": _row_stat, "row_json": _row_json_stat},
)
