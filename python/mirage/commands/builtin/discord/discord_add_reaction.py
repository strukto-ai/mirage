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
from mirage.core.discord.react import add_reaction
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--channel_id", value_kind=OperandKind.TEXT),
    Option(long="--message_id", value_kind=OperandKind.TEXT),
    Option(long="--reaction", value_kind=OperandKind.TEXT),
), )


@command("discord-add-reaction", resource="discord", spec=SPEC, write=True)
async def discord_add_reaction(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    channel_id = _extra.get("channel_id", "")
    message_id = _extra.get("message_id", "")
    reaction = _extra.get("reaction", "")
    if not channel_id or not isinstance(channel_id, str):
        raise ValueError("--channel_id is required")
    if not message_id or not isinstance(message_id, str):
        raise ValueError("--message_id is required")
    if not reaction or not isinstance(reaction, str):
        raise ValueError("--reaction is required")
    await add_reaction(accessor.config, channel_id, message_id, reaction)
    out = json.dumps({
        "ok": True
    }, ensure_ascii=False, separators=(",", ":")).encode()
    return out, IOResult()
