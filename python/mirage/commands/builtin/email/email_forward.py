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

from mirage.accessor.email import EmailAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.email._client import fetch_message
from mirage.core.email.send import forward_message
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--uid", value_kind=OperandKind.TEXT),
    Option(long="--folder", value_kind=OperandKind.TEXT),
    Option(long="--to", value_kind=OperandKind.TEXT),
), )


@command("email-forward", resource="email", spec=SPEC, write=True)
async def email_forward(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    uid = _extra.get("uid", "")
    folder = _extra.get("folder", "")
    to = _extra.get("to", "")
    if not uid or not isinstance(uid, str):
        raise ValueError("--uid is required")
    if not folder or not isinstance(folder, str):
        raise ValueError("--folder is required")
    if not to or not isinstance(to, str):
        raise ValueError("--to is required")
    original = await fetch_message(accessor, folder, uid)
    result = await forward_message(accessor.config, original, to)
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
