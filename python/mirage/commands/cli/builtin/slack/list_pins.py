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

from mirage.accessor.slack import SlackAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.slack.pins import list_pins as list_pins_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def list_pins(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    items = await list_pins_core(accessor, fl.as_str("channel") or "")
    out = json.dumps(items, ensure_ascii=False, separators=(",", ":")).encode()
    return out, IOResult()
