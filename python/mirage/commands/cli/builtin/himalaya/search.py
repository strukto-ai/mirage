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
from mirage.commands.cli.builtin.himalaya.list import DEFAULT_PAGE_SIZE
from mirage.commands.cli.builtin.himalaya.query import (page_slice,
                                                        parse_query,
                                                        sort_headers,
                                                        uid_budget)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.email._client import fetch_headers, list_message_uids
from mirage.core.email.config import EmailConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def search_envelopes(
        inv: CLIInvocation[EmailConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    mailbox = fl.as_str("mailbox") or "INBOX"
    page = fl.as_int("page") or 1
    page_size = fl.as_int("page_size") or DEFAULT_PAGE_SIZE
    # The shell already split the query; upstream joins argv the same
    # way before parsing, so a pattern with spaces needs literal quotes.
    query = parse_query(" ".join(inv.texts))
    budget = uid_budget(page, page_size, query.sorters,
                        inv.config.max_messages)
    accessor = EmailAccessor(inv.config)
    try:
        uids = await list_message_uids(accessor, mailbox, query.criteria,
                                       budget)
        headers = await fetch_headers(accessor, mailbox, uids) if uids else []
    finally:
        await accessor.close()
    page_of = page_slice(sort_headers(headers, query.sorters), page, page_size)
    out = json.dumps(page_of, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
