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

from mirage.accessor.notion import NotionAccessor
from mirage.commands.cli.builtin.ntn.util import (
    first_text,
    notion_transport,
    pretty_json,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.notion.normalize import plain_text_of
from mirage.core.notion.pages import get_page, get_page_markdown
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.records import as_object
from mirage.utils.yaml import dump_yaml


def _property_value(prop: dict[str, Any]) -> Any:
    kind = prop.get("type", "")
    value = prop.get(kind)
    if kind in ("title", "rich_text"):
        return plain_text_of(value)
    if kind in ("select", "status", "created_by", "last_edited_by"):
        item = as_object(value)
        return item.get("name") or item.get("id")
    if kind in ("multi_select", "people", "files", "relation") and isinstance(
        value, list
    ):
        return [
            item.get("name") or item.get("id")
            for item in value
            if isinstance(item, dict)
        ]
    if kind in ("formula", "rollup") and isinstance(value, dict):
        return _property_value(value)
    return value


async def get(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    page_id = first_text(texts, "page id")
    # The Markdown endpoint omits the properties printed in the frontmatter.
    line = notion_transport(accessor, ctx)
    rendered = await get_page_markdown(line, page_id)
    page = await get_page(line, page_id)
    if fl.as_bool("json"):
        return pretty_json({"markdown": rendered, "page": page}), IOResult()
    body = rendered.get("markdown", "")
    fields = {
        name: _property_value(as_object(prop))
        for name, prop in sorted(as_object(page.get("properties")).items())
    }
    text = f"---\n{dump_yaml(fields, sort_keys=True, multiline=True)}---\n\n{body}"
    return text.encode(), IOResult()
