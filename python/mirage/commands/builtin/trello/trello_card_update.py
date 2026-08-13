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
from mirage.commands.builtin.trello._input import (file_operand,
                                                   resolve_text_input)
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, FlagView, Option
from mirage.core.trello._client import card_update
from mirage.core.trello.normalize import normalize_card
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--card_id", type="str"),
    Option(long="--name", type="str"),
    Option(long="--desc", type="str"),
    Option(long="--desc_file", type="path"),
    Option(long="--due", type="str"),
    Option(long="--closed", type="str"),
), )


@command("trello card update", resource="trello", spec=SPEC)
async def trello_card_update(
        accessor: TrelloAccessor, paths: list[PathSpec], texts: list[str],
        opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPEC)
    config = accessor.config
    card_id = fl.as_str("card_id")
    if not card_id:
        raise ValueError("--card_id is required")
    name = fl.as_str("name")
    desc = None
    if (fl.as_str("desc") is not None
            or file_operand(fl, "desc_file") is not None
            or opts.stdin is not None):
        desc = await resolve_text_input(
            config,
            inline_text=fl.as_str("desc"),
            file_path=file_operand(fl, "desc_file"),
            stdin=opts.stdin,
            error_message="desc is required",
        )
    closed = None
    closed_flag = fl.as_str("closed")
    if closed_flag is not None:
        closed = closed_flag.lower() in ("true", "1", "yes")
    due = fl.as_str("due")
    card = await card_update(
        config,
        card_id=card_id,
        name=name,
        desc=desc,
        closed=closed,
        due=due,
    )
    return yield_bytes(
        json.dumps(normalize_card(card),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
