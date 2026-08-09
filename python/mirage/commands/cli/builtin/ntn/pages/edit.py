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

from mirage.commands.cli.builtin.ntn.util import (content_or_stdin, first_text,
                                                  notion_config)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.pages import replace_page_markdown
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def edit(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    page_id = first_text(inv.texts, "page id")
    markdown = await content_or_stdin(fl.as_str("content"), inv.stdin)
    await replace_page_markdown(notion_config(inv), page_id, markdown)
    return yield_bytes(f"{page_id}\n".encode()), IOResult()
