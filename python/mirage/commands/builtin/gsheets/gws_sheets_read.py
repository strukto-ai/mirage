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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.gsheets.read import read_values
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--spreadsheet", value_kind=OperandKind.TEXT),
    Option(long="--range", value_kind=OperandKind.TEXT),
), )


@command("gws sheets +read", resource=["gsheets", "gdrive"], spec=SPEC)
async def gws_sheets_read(
    accessor: GSheetsAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    sheet_id = _extra.get("spreadsheet", "")
    range_ = _extra.get("range", "")
    if not sheet_id or not isinstance(sheet_id, str):
        raise ValueError("--spreadsheet is required")
    if not range_ or not isinstance(range_, str):
        raise ValueError("--range is required")
    result = await read_values(accessor.token_manager, sheet_id, range_)
    return yield_bytes(result), IOResult()
