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

from mirage.accessor.gmail import GmailAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.gmail.send import reply_message
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(
    description="Reply to the sender of a Gmail message (excludes CC).",
    options=(
        Option(long="--message-id",
               value_kind=OperandKind.TEXT,
               description="Gmail message ID to reply to (required)"),
        Option(long="--body",
               value_kind=OperandKind.TEXT,
               description="Reply body (use $'\\n' for newlines; required)"),
    ),
)


@command("gws-gmail-reply", resource="gmail", spec=SPEC, write=True)
async def gws_gmail_reply(
    accessor: GmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    message_id = _extra.get("message_id", "")
    body = _extra.get("body", "")
    if not message_id or not isinstance(message_id, str):
        raise ValueError("--message-id is required")
    if not body or not isinstance(body, str):
        raise ValueError("--body is required")
    result = await reply_message(accessor.token_manager, message_id, body)
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
