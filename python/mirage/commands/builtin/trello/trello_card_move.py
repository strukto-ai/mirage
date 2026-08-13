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
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, FlagView, Option
from mirage.core.trello._client import card_move
from mirage.core.trello.normalize import normalize_card
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--card_id", type="str"),
    Option(long="--list_id", type="str"),
), )


@command("trello card move", resource="trello", spec=SPEC)
async def trello_card_move(
        accessor: TrelloAccessor, paths: list[PathSpec], texts: list[str],
        opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPEC)
    config = accessor.config
    card_id = fl.as_str("card_id")
    if not card_id:
        raise ValueError("--card_id is required")
    list_id = fl.as_str("list_id")
    if not list_id:
        raise ValueError("--list_id is required")
    card = await card_move(config, card_id=card_id, list_id=list_id)
    return yield_bytes(
        json.dumps(normalize_card(card),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
