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
from mirage.core.gmail.messages import (_extract_header, get_message_raw,
                                        list_messages)
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def triage(
        inv: CLIInvocation[GoogleConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    query = fl.as_str("query") or "is:unread"
    max_results = fl.as_int("max") or 20
    token_manager = TokenManager(inv.config)
    msgs = await list_messages(token_manager,
                               query=query,
                               max_results=max_results)
    summaries = []
    for m in msgs:
        mid = m["id"]
        raw = await get_message_raw(token_manager, mid)
        headers = raw.get("payload", {}).get("headers", [])
        summaries.append({
            "id": mid,
            "from": _extract_header(headers, "From"),
            "subject": _extract_header(headers, "Subject"),
            "date": _extract_header(headers, "Date"),
            "snippet": raw.get("snippet", ""),
        })
    out = json.dumps(summaries, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
