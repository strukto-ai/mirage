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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.gsheets.create import create_spreadsheet
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(Option(long="--json",
                                   value_kind=OperandKind.TEXT), ), )


@command("gws-sheets-spreadsheets-create",
         resource=["gsheets", "gdrive"],
         spec=SPEC,
         write=True)
async def gws_sheets_spreadsheets_create(
    accessor: GSheetsAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    json_str = _extra.get("json", "")
    if not json_str or not isinstance(json_str, str):
        raise ValueError('Usage: gws-sheets-spreadsheets-create '
                         "--json '{\"properties\": {\"title\": \"...\"}}'")
    body = json.loads(json_str)
    title = body.get("properties", {}).get("title", "")
    if not title:
        raise ValueError("JSON must contain properties.title")
    result = await create_spreadsheet(accessor.token_manager, title)
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
