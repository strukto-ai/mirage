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

from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.core.gsheets.read import read_values
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def read(
    config: GoogleConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    async with TokenManager(config) as tm:
        result = await read_values(
            tm, fl.as_str("spreadsheet") or "", fl.as_str("range") or ""
        )
    return yield_bytes(result), IOResult()
