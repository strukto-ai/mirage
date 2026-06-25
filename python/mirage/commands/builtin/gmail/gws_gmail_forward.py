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
from mirage.core.gmail.send import forward_message
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(
    description="Forward a Gmail message to a new recipient.",
    options=(
        Option(long="--message-id",
               value_kind=OperandKind.TEXT,
               description="Gmail message ID to forward (required)"),
        Option(long="--to",
               value_kind=OperandKind.TEXT,
               description="Forward recipient email address (required)"),
    ),
)


@command("gws-gmail-forward", resource="gmail", spec=SPEC, write=True)
async def gws_gmail_forward(
    accessor: GmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    message_id = _extra.get("message_id", "")
    to = _extra.get("to", "")
    if not message_id or not isinstance(message_id, str):
        raise ValueError("--message-id is required")
    if not to or not isinstance(to, str):
        raise ValueError("--to is required")
    result = await forward_message(accessor.token_manager, message_id, to)
    out = json.dumps(result, ensure_ascii=False,
                 separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
