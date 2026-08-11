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

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.builder import Source
from mirage.commands.cli.builtin.himalaya.util import first_text, route
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.email._client import fetch_message
from mirage.core.email.config import EmailConfig
from mirage.io.types import ByteSource, IOResult


async def reply(
        inv: CLIInvocation[EmailConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    uid = first_text(inv.texts, "message id")
    mailbox = fl.as_str("mailbox") or "INBOX"
    accessor = EmailAccessor(inv.config)
    try:
        original = await fetch_message(accessor, mailbox, uid)
    finally:
        await accessor.close()
    source = Source(
        message=original,
        mode="reply",
        posting_style=("bottom"
                       if fl.as_str("posting_style") == "bottom" else "top"),
        quote_headline=fl.as_str("quote_headline") or "",
    )
    return await route(inv.config, fl, inv.stdin, source, inv.ops)
