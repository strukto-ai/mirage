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

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.discord.members import search_members
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--guild_id", value_kind=OperandKind.TEXT),
    Option(long="--query", value_kind=OperandKind.TEXT),
), )


@command("discord-list-members", resource="discord", spec=SPEC)
async def discord_list_members(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    guild_id = _extra.get("guild_id", "")
    query = _extra.get("query", "")
    if not guild_id or not isinstance(guild_id, str):
        raise ValueError("--guild_id is required")
    if not query or not isinstance(query, str):
        raise ValueError("--query is required")
    members = await search_members(accessor.config, guild_id, query)
    out = json.dumps(members, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return out, IOResult()
