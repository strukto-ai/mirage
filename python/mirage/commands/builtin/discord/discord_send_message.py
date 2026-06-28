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
from mirage.core.discord.post import send_message
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--channel_id", value_kind=OperandKind.TEXT),
    Option(long="--text", value_kind=OperandKind.TEXT),
    Option(long="--message_id", value_kind=OperandKind.TEXT),
), )


@command("discord-send-message", resource="discord", spec=SPEC, write=True)
async def discord_send_message(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    channel_id = _extra.get("channel_id", "")
    text = _extra.get("text", "")
    message_id = _extra.get("message_id", "")
    if not channel_id or not isinstance(channel_id, str):
        raise ValueError("--channel_id is required")
    if not text or not isinstance(text, str):
        raise ValueError("--text is required")
    ref = message_id if message_id and isinstance(message_id, str) else None
    result = await send_message(accessor.config, channel_id, text, ref)
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return out, IOResult()
