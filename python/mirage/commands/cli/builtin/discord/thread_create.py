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

from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.threads import create_thread
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def thread_create(
        inv: CLIInvocation[DiscordConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    result = await create_thread(
        inv.config,
        fl.as_str("channel") or "",
        fl.as_str("name") or "",
        message_id=fl.as_str("message"),
    )
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
