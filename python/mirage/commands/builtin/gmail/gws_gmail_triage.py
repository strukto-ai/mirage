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

from mirage.accessor.gmail import GmailAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.gmail.messages import (_extract_header, get_message_raw,
                                        list_messages)
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(
    description=("List message summaries (id, from, subject, date, snippet) "
                 "for a Gmail search query."),
    options=(
        Option(long="--query",
               value_kind=OperandKind.TEXT,
               description='Gmail search query (default: "is:unread")'),
        Option(long="--max",
               value_kind=OperandKind.TEXT,
               description="Max results to return (default: 20)"),
    ),
)


@command("gws-gmail-triage", resource="gmail", spec=SPEC)
async def gws_gmail_triage(
    accessor: GmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    query = _extra.get("query", "is:unread")
    if not isinstance(query, str):
        query = "is:unread"
    raw_max = _extra.get("max", 20)
    max_results = int(raw_max) if isinstance(raw_max, (int, str)) else 20
    msgs = await list_messages(accessor.token_manager,
                               query=query,
                               max_results=max_results)
    summaries = []
    for m in msgs:
        mid = m["id"]
        raw = await get_message_raw(accessor.token_manager, mid)
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
