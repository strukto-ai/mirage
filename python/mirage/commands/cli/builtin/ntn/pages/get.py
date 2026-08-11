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

from mirage.commands.cli.builtin.ntn.util import (first_text, notion_config,
                                                  pretty_json)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.pages import get_page, get_page_markdown
from mirage.core.notion.pathing import extract_title
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def get(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    page_id = first_text(inv.texts, "page id")
    # Both calls happen either way: the body comes from the markdown
    # endpoint and the title heading the frontmatter only exists on the
    # page object.
    config = notion_config(inv)
    rendered = await get_page_markdown(config, page_id)
    page = await get_page(config, page_id)
    if fl.as_bool("json"):
        return yield_bytes(pretty_json({
            "markdown": rendered,
            "page": page
        })), IOResult()
    body = rendered.get("markdown", "")
    text = f"---\ntitle: {extract_title(page)}\n---\n\n{body}"
    return yield_bytes(text.encode()), IOResult()
