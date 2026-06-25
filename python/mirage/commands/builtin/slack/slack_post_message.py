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
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.slack.post import post_message
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--channel_id", value_kind=OperandKind.TEXT),
    Option(long="--text", value_kind=OperandKind.TEXT),
), )


@command("slack-post-message", resource="slack", spec=SPEC, write=True)
async def slack_post_message(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    channel_id = _extra.get("channel_id", "")
    text = _extra.get("text", "")
    if not channel_id or not isinstance(channel_id, str):
        raise ValueError("--channel_id is required")
    if not text or not isinstance(text, str):
        raise ValueError("--text is required")
    result = await post_message(accessor.config, channel_id, text)
    out = json.dumps(result, ensure_ascii=False,
                 separators=(",", ":")).encode()
    return out, IOResult()
