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

import json

from mirage.accessor.notion import NotionAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, ValueType, Option
from mirage.core.notion.pages import search_pages
from mirage.core.notion.pathing import extract_title
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--query", type="str"),
    Option(long="--limit", type="str"),
))


@command("notion-search", resource="notion", spec=SPEC)
async def notion_search(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    query = _extra.get("query")
    if not query or not isinstance(query, str):
        raise ValueError("--query is required")
    limit_str = _extra.get("limit")
    limit = int(limit_str) if isinstance(limit_str, str) else 20
    pages = await search_pages(accessor.config, query=query, page_size=limit)
    results = []
    for page in pages[:limit]:
        title = extract_title(page) or "Untitled"
        page_id = page.get("id", "")
        url = page.get("url", "")
        last_edited = page.get("last_edited_time", "")
        parent = page.get("parent", {})
        results.append({
            "title": title,
            "page_id": page_id,
            "url": url,
            "last_edited": last_edited,
            "parent_type": parent.get("type", ""),
        })
    return yield_bytes(
        json.dumps(results, ensure_ascii=False,
                   indent=2).encode()), IOResult()
