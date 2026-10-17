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
from mirage.commands.cli.builtin.himalaya.util import first_text
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import fetch_message, fetch_raw_message
from mirage.core.email.config import EmailConfig
from mirage.core.email.render import message_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def read(
    config: EmailConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    uid = first_text(texts, "message id")
    mailbox = fl.as_str("mailbox", "INBOX")
    accessor = EmailAccessor(config)
    try:
        if fl.as_bool("raw"):
            return yield_bytes(
                await fetch_raw_message(accessor, mailbox, uid)
            ), IOResult()
        processed = await fetch_message(accessor, mailbox, uid)
    finally:
        await accessor.close()
    # The same renderer the mount serves, so `message read` and `cat` of
    # the .email.json cannot drift apart.
    out = message_json_bytes(processed)
    return yield_bytes(out), IOResult()
