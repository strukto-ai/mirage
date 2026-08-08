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

from mirage.commands.cli.builtin.himalaya.smtp import send_raw
from mirage.commands.cli.types import CLIInvocation
from mirage.core.email.config import EmailConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult, materialize


async def send(
        inv: CLIInvocation[EmailConfig]) -> tuple[ByteSource | None, IOResult]:
    # The operand is a whole RFC 5322 message, so tokens rejoin with a
    # space and literal \n become real line breaks, the way upstream's
    # MessageArg resolves an inline message.
    inline = " ".join(inv.texts).replace("\\r", "").replace("\\n", "\n")
    raw = inline.encode() if inline else await materialize(inv.stdin)
    if not raw.strip():
        raise ValueError("no message provided: pass it as an argument "
                         "or pipe it via standard input")
    message = await send_raw(inv.config, raw)
    result = {
        "status": "sent",
        "to": message["To"],
        "subject": message["Subject"],
    }
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
