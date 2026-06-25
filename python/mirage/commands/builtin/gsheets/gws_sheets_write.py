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

import aiohttp

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.gsheets._client import SHEETS_API_BASE, google_headers
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--params", value_kind=OperandKind.TEXT),
    Option(long="--json", value_kind=OperandKind.TEXT),
), )


@command("gws-sheets-write",
         resource=["gsheets", "gdrive"],
         spec=SPEC,
         write=True)
async def gws_sheets_write(
    accessor: GSheetsAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    params_str = _extra.get("params", "")
    json_str = _extra.get("json", "")
    if not params_str or not isinstance(params_str, str):
        raise ValueError("--params is required")
    if not json_str or not isinstance(json_str, str):
        raise ValueError("--json is required")
    p = json.loads(params_str)
    sheet_id = p.get("spreadsheetId", "")
    range_ = p.get("range", "")
    vio = p.get("valueInputOption", "USER_ENTERED")
    if not sheet_id:
        raise ValueError("--params must contain spreadsheetId")
    if not range_:
        raise ValueError("--params must contain range")
    body = json.loads(json_str)
    base = f"{SHEETS_API_BASE}/spreadsheets/{sheet_id}"
    url = f"{base}/values/{range_}?valueInputOption={vio}"
    headers = await google_headers(accessor.token_manager)
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers, json=body) as resp:
            resp.raise_for_status()
            result = await resp.json()
    out = json.dumps(result, ensure_ascii=False,
                 separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
