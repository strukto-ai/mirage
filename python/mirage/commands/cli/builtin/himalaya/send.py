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
from mirage.commands.cli.builtin.himalaya.deliver import deliver
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec


async def send(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    # The operand is a whole RFC 5322 message, so tokens rejoin with a
    # space and literal \n become real line breaks, the way upstream's
    # MessageArg resolves an inline message.
    inline = " ".join(texts).replace("\\r", "").replace("\\n", "\n")
    raw = inline.encode() if inline else await materialize(ctx.stdin)
    if not raw.strip():
        raise ValueError(
            "no message provided: pass it as an argument "
            "or pipe it via standard input"
        )
    message, warning = await deliver(
        accessor, raw, FlagView(ctx.flags).as_str("save")
    )
    result = {
        "status": "sent",
        "to": message["To"],
        "subject": message["Subject"],
    }
    out = json.dumps(
        result, ensure_ascii=False, separators=(",", ":")
    ).encode()
    return yield_bytes(out), IOResult(
        stderr=warning.encode() if warning else None
    )
