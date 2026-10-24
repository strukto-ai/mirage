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

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.gmail.messages import (
    _extract_header,
    get_message_raw,
    list_messages,
)
from mirage.core.render.json import compact_json_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def triage(
    accessor: GoogleApiAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    query = fl.as_str("query", "is:unread")
    max_results = fl.as_int("max", 20)
    summaries = []
    msgs = await list_messages(
        accessor.token_manager, query=query, max_results=max_results
    )
    for m in msgs:
        mid = m["id"]
        raw = await get_message_raw(accessor.token_manager, mid)
        headers = raw.get("payload", {}).get("headers", [])
        summaries.append(
            {
                "id": mid,
                "from": _extract_header(headers, "From"),
                "subject": _extract_header(headers, "Subject"),
                "date": _extract_header(headers, "Date"),
                "snippet": raw.get("snippet", ""),
            }
        )
    out = compact_json_bytes(summaries)
    return out, IOResult()
