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

from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.normalize import to_json_bytes
from mirage.core.notion.pages import search_pages
from mirage.core.notion.pathing import extract_title
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def search(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    limit = fl.as_int("limit") or 20
    pages = await search_pages(
        inv.config,
        query=fl.as_str("query") or "",
        page_size=limit,
        max_results=limit,
    )
    results = [{
        "title": extract_title(page) or "Untitled",
        "page_id": page.get("id", ""),
        "url": page.get("url", ""),
        "last_edited": page.get("last_edited_time", ""),
        "parent_type": (page.get("parent") or {}).get("type", ""),
    } for page in pages[:limit]]
    return yield_bytes(to_json_bytes(results)), IOResult()
