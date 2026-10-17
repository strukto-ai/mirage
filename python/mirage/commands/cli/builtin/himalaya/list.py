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
from mirage.commands.cli.builtin.himalaya.query import (
    page_slice,
    page_window,
    sort_headers,
    uid_budget,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import fetch_headers, list_message_uids
from mirage.core.email.render import envelopes_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

DEFAULT_PAGE_SIZE = 25


async def list_envelopes(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    mailbox = fl.as_str("mailbox", "INBOX")
    page, page_size = page_window(
        fl.as_int("page", 1),
        fl.as_int("page_size", DEFAULT_PAGE_SIZE),
        accessor.config.max_messages,
    )
    budget = uid_budget(page, page_size, (), accessor.config.max_messages)
    uids = await list_message_uids(accessor, mailbox, "ALL", budget)
    headers = await fetch_headers(accessor, mailbox, uids) if uids else []
    page_of = page_slice(sort_headers(headers, ()), page, page_size)
    out = envelopes_json_bytes(page_of)
    return yield_bytes(out), IOResult()
