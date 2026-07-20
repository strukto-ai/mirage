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
from mirage.commands.builtin.trello._input import resolve_text_input
from mirage.commands.registry import command
from mirage.commands.spec.types import (CommandSpec, FlagView, OperandKind,
                                        Option)
from mirage.core.trello._client import card_create
from mirage.core.trello.normalize import normalize_card
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--list_id", value_kind=OperandKind.TEXT),
    Option(long="--name", value_kind=OperandKind.TEXT),
    Option(long="--desc", value_kind=OperandKind.TEXT),
    Option(long="--desc_file", value_kind=OperandKind.PATH),
), )


@command("trello card create", resource="trello", spec=SPEC, write=True)
async def trello_card_create(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(_extra, spec=SPEC)
    config = accessor.config
    list_id = _extra.get("list_id")
    if not list_id or not isinstance(list_id, str):
        raise ValueError("--list_id is required")
    name = _extra.get("name")
    if not name or not isinstance(name, str):
        raise ValueError("--name is required")
    desc = None
    if (_extra.get("desc") or _extra.get("desc_file") or stdin is not None):
        desc = await resolve_text_input(
            config,
            inline_text=fl.as_str("desc"),
            file_path=fl.as_str("desc_file"),
            stdin=stdin,
            error_message="desc is required",
        )
    card = await card_create(
        config,
        list_id=list_id,
        name=name,
        desc=desc,
    )
    return yield_bytes(
        json.dumps(normalize_card(card),
                   ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
