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
    content_or_stdin,
    first_text,
    notion_transport,
    pretty_json,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.notion.pages import replace_page_markdown
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def edit(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    page_id = first_text(texts, "page id")
    markdown = await content_or_stdin(fl.as_str("content"), ctx.stdin)
    # The PATCH answers with the page's new markdown, which is what
    # `--json` is for; printing the id under it would throw the response
    # away on the one flag that asks for it.
    edited = await replace_page_markdown(
        notion_transport(accessor, ctx), page_id, markdown
    )
    if fl.as_bool("json"):
        return pretty_json(edited), IOResult()
    return f"{page_id}\n".encode(), IOResult()
