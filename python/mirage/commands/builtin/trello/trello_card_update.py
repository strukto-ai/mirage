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
from collections.abc import AsyncIterator

from mirage.accessor.trello import TrelloAccessor
from mirage.commands.builtin.trello._input import resolve_text_input
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.trello._client import card_update
from mirage.core.trello.normalize import normalize_card
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--card_id", value_kind=OperandKind.TEXT),
    Option(long="--name", value_kind=OperandKind.TEXT),
    Option(long="--desc", value_kind=OperandKind.TEXT),
    Option(long="--desc_file", value_kind=OperandKind.PATH),
    Option(long="--due", value_kind=OperandKind.TEXT),
    Option(long="--closed", value_kind=OperandKind.TEXT),
), )


@command("trello-card-update", resource="trello", spec=SPEC)
async def trello_card_update(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    config = accessor.config
    card_id = _extra.get("card_id")
    if not card_id or not isinstance(card_id, str):
        raise ValueError("--card_id is required")
    name = _extra.get("name") if isinstance(_extra.get("name"), str) else None
    desc = None
    if (_extra.get("desc") is not None or _extra.get("desc_file") is not None
            or stdin is not None):
        desc = await resolve_text_input(
            config,
            inline_text=_extra.get("desc") if isinstance(
                _extra.get("desc"), str) else None,
            file_path=_extra.get("desc_file") if isinstance(
                _extra.get("desc_file"), str) else None,
            stdin=stdin,
            error_message="desc is required",
        )
    closed = None
    if isinstance(_extra.get("closed"), str):
        closed = _extra["closed"].lower() in ("true", "1", "yes")
    due = _extra.get("due") if isinstance(_extra.get("due"), str) else None
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
