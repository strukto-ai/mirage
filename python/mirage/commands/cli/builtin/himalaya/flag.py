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
from mirage.commands.cli.builtin.himalaya.printer import rendered
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import FlagOp, store_flags
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

IMAP_FLAGS = {
    "seen": "\\Seen",
    "answered": "\\Answered",
    "flagged": "\\Flagged",
    "draft": "\\Draft",
}
VERBS: dict[FlagOp, str] = {"add": "added", "set": "set", "remove": "removed"}


async def _store(
    accessor: EmailAccessor, texts: list[str], ctx: Context, op: FlagOp
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    names = fl.as_list("flag")
    await store_flags(
        accessor,
        fl.as_str("mailbox", "INBOX"),
        texts,
        [IMAP_FLAGS[name] for name in names],
        op,
    )
    text = f"Successfully {VERBS[op]} flags: {', '.join(names)}"
    return rendered(fl, {"flags": names}, text), IOResult()


async def flag_add(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    return await _store(accessor, texts, ctx, "add")


async def flag_set(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    return await _store(accessor, texts, ctx, "set")


async def flag_remove(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    return await _store(accessor, texts, ctx, "remove")
