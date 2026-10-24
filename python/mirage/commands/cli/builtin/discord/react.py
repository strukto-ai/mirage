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

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.discord.react import add_reaction
from mirage.core.render.json import compact_json_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def react(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    await add_reaction(
        accessor,
        fl.as_str("channel") or "",
        fl.as_str("message") or "",
        fl.as_str("emoji") or "",
    )
    out = compact_json_bytes({"ok": True})
    return out, IOResult()
