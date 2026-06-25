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
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.email._client import fetch_headers
from mirage.core.email.search import search_messages
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--folder", value_kind=OperandKind.TEXT),
    Option(long="--max", value_kind=OperandKind.TEXT),
    Option(long="--unseen"),
    Option(long="--subject", value_kind=OperandKind.TEXT),
    Option(long="--from", value_kind=OperandKind.TEXT),
    Option(long="--to", value_kind=OperandKind.TEXT),
    Option(long="--body", value_kind=OperandKind.TEXT),
    Option(long="--since", value_kind=OperandKind.TEXT),
    Option(long="--before", value_kind=OperandKind.TEXT),
))


@command("email-triage", resource="email", spec=SPEC)
async def email_triage(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    folder = _extra.get("folder", "INBOX")
    if not isinstance(folder, str):
        folder = "INBOX"
    max_results = int(_extra.get("max", 20))
    uids = await search_messages(
        accessor,
        folder,
        text=_extra.get("body"),
        subject=_extra.get("subject"),
        from_addr=_extra.get("from"),
        to_addr=_extra.get("to"),
        since=_extra.get("since"),
        before=_extra.get("before"),
        unseen=bool(_extra.get("unseen")),
        max_results=max_results,
    )
    if not uids:
        out = json.dumps([], ensure_ascii=False,
                 separators=(",", ":")).encode()
        return yield_bytes(out), IOResult()
    headers = await fetch_headers(accessor, folder, uids)
    out = json.dumps(headers, ensure_ascii=False,
                 separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
