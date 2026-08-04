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
from mirage.commands.spec.types import FlagView
from mirage.core.email._client import fetch_message
from mirage.core.email.config import EmailConfig
from mirage.core.email.send import reply_all_message, reply_message
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def reply(
    config: EmailConfig,
    paths: list[PathSpec],
    *texts: str,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags)
    uid = fl.as_str("uid") or ""
    folder = fl.as_str("folder") or ""
    body = fl.as_str("body") or ""
    accessor = EmailAccessor(config)
    try:
        original = await fetch_message(accessor, folder, uid)
    finally:
        await accessor.close()
    if fl.as_bool("all"):
        result = await reply_all_message(config, original, body)
    else:
        result = await reply_message(config, original, body)
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
