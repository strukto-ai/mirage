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
from mirage.core.notion.normalize import to_json_bytes
from mirage.core.notion.pages import create_comment
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(
    options=(Option(long="--json", type="str"), ))


@command("notion-comment-add", resource="notion", spec=SPEC)
async def notion_comment_add(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    json_str = _extra.get("json", "")
    if not json_str or not isinstance(json_str, str):
        raise ValueError(
            'Usage: notion-comment-add --json \'{"parent":{"page_id":"..."},'
            '"rich_text":[{"text":{"content":"Comment text"}}]}\'')
    body = json.loads(json_str)
    if "parent" not in body:
        raise ValueError("JSON must contain 'parent'")
    comment = await create_comment(accessor.config, body)
    return yield_bytes(to_json_bytes(comment)), IOResult()
