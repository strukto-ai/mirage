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

from typing import cast

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.builder import PostingStyle, Source
from mirage.commands.cli.builtin.himalaya.util import route
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import fetch_message
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def forward(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    original = await fetch_message(
        accessor, fl.as_str("mailbox", "INBOX"), texts[0]
    )
    source = Source(
        message=original,
        mode="forward",
        posting_style=cast(PostingStyle, fl.as_str("posting_style", "top")),
        quote_headline=fl.as_str("quote_headline") or "",
    )
    return await route(accessor, fl, ctx.stdin, source, ctx.vfs, ctx.ids)
