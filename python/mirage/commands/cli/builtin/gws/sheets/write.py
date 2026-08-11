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

from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.gsheets.write import update_values
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


def values_json_from_flags(fl: FlagView) -> str:
    """Read the 2D values payload: --json-values wins over --values.

    Args:
        fl (FlagView): the leaf's flag view.
    """
    json_values = fl.as_str("json_values")
    if json_values:
        return json_values
    values_csv = fl.as_str("values")
    if values_csv:
        return json.dumps([values_csv.split(",")])
    raise ValueError("--values or --json-values is required")


async def write(
        inv: CLIInvocation[GoogleConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    result = await update_values(TokenManager(inv.config),
                                 fl.as_str("spreadsheet") or "",
                                 fl.as_str("range") or "",
                                 values_json_from_flags(fl))
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
