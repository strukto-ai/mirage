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

from mirage.accessor.trello import TrelloAccessor
from mirage.commands.builtin.trello._input import (
    file_operand,
    resolve_text_input,
)
from mirage.commands.builtin.trello._scope import require_list
from mirage.commands.config import Context, command
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.context import require_mount_writable
from mirage.core.trello.client import card_create
from mirage.core.trello.normalize import normalize_card
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(
    arguments=(
        Argument("--list_id", type="str"),
        Argument("--name", type="str"),
        Argument("--desc", type="str"),
        Argument("--desc_file", type="path"),
    )
)


@command("trello card create", vfs="trello", spec=SPEC, write=True)
async def trello_card_create(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPEC)
    list_id = fl.as_str("list_id")
    if not list_id:
        raise ValueError("--list_id is required")
    name = fl.as_str("name")
    if not name:
        raise ValueError("--name is required")
    desc = None
    if (
        fl.as_str("desc") is not None
        or file_operand(fl, "desc_file") is not None
        or ctx.stdin is not None
    ):
        desc = await resolve_text_input(
            accessor,
            ctx,
            inline_text=fl.as_str("desc"),
            file_path=file_operand(fl, "desc_file"),
            error_message="desc is required",
        )
    # A card write is addressed by id, not path, so only the mount-wide
    # grant can admit it (a write-granting carve-out names no card).
    require_mount_writable()
    await require_list(accessor, list_id)
    card = await card_create(accessor, list_id=list_id, name=name, desc=desc)
    return yield_bytes(
        json.dumps(
            normalize_card(card), ensure_ascii=False, separators=(",", ":")
        ).encode()
    ), IOResult()
