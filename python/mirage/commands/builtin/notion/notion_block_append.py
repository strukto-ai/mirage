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
from mirage.commands.spec.types import CommandSpec, Option
from mirage.core.notion.normalize import normalize_page, to_json_bytes
from mirage.core.notion.pages import (append_blocks, get_page,
                                      list_block_children)
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--params", type="str"),
    Option(long="--json", type="str"),
))


@command("notion-block-append", resource="notion", spec=SPEC)
async def notion_block_append(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    params_str = _extra.get("params", "")
    json_str = _extra.get("json", "")
    if not params_str or not isinstance(params_str, str):
        raise ValueError("--params is required (must contain block_id)")
    if not json_str or not isinstance(json_str, str):
        raise ValueError("--json is required (must contain children)")
    params = json.loads(params_str)
    block_id = params.get("block_id", "")
    if not block_id:
        raise ValueError("--params must contain block_id")
    body = json.loads(json_str)
    await append_blocks(accessor.config, block_id, body)
    page = await get_page(accessor.config, block_id)
    page_blocks = await list_block_children(accessor.config, block_id)
    result = normalize_page(page, page_blocks)
    return yield_bytes(to_json_bytes(result)), IOResult()
