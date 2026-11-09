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
from mirage.commands.cli.builtin.himalaya.printer import notice
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import copy_messages, move_messages
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _report(fl: FlagView, count: int, verb: str) -> bytes:
    if count == 0:
        text = f"No message {verb}: no id matched in the source mailbox"
    elif count == 1:
        text = f"1 message successfully {verb}"
    else:
        text = f"{count} messages successfully {verb}"
    return notice(fl, text)


async def message_copy(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    count = await copy_messages(
        accessor,
        fl.as_str("from", "INBOX"),
        fl.as_str("to") or "",
        texts,
    )
    return _report(fl, count, "copied"), IOResult()


async def message_move(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    count = await move_messages(
        accessor,
        fl.as_str("from", "INBOX"),
        fl.as_str("to") or "",
        texts,
    )
    return _report(fl, count, "moved"), IOResult()
