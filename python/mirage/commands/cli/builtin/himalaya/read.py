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
from mirage.commands.cli.builtin.himalaya.util import first_text
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.email._client import fetch_message, fetch_raw_message
from mirage.core.email.config import EmailConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def read(
        inv: CLIInvocation[EmailConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    uid = first_text(inv.texts, "message id")
    mailbox = fl.as_str("mailbox") or "INBOX"
    accessor = EmailAccessor(inv.config)
    try:
        if fl.as_bool("raw"):
            return yield_bytes(await fetch_raw_message(accessor, mailbox,
                                                       uid)), IOResult()
        processed = await fetch_message(accessor, mailbox, uid)
    finally:
        await accessor.close()
    out = json.dumps(processed, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
