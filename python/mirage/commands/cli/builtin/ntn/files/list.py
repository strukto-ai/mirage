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
from mirage.commands.cli.builtin.ntn.util import (
    UPLOAD_COLUMNS,
    notion_transport,
    pretty_json,
    upload_row,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.notion.file_uploads import list_file_uploads
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

COLUMNS = UPLOAD_COLUMNS[:-1]


async def files_list(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    page = await list_file_uploads(notion_transport(accessor, ctx))
    results = page.get("results", [])
    if fl.as_bool("json"):
        return pretty_json(results), IOResult()
    rows = "".join(f"{upload_row(row, COLUMNS)}\n" for row in results)
    return rows.encode(), IOResult()
