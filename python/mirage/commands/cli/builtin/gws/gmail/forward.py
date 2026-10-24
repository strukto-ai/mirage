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

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.gmail.send import forward_message
from mirage.core.render.json import compact_json_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def forward(
    accessor: GoogleApiAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    result = await forward_message(
        accessor.token_manager,
        fl.as_str("message_id") or "",
        fl.as_str("to") or "",
    )
    out = compact_json_bytes(result)
    return out, IOResult()
