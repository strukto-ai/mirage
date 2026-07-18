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
from mirage.core.trello._client import comment_update
from mirage.core.trello.normalize import normalize_comment
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--card_id", value_kind=OperandKind.TEXT),
    Option(long="--comment_id", value_kind=OperandKind.TEXT),
    Option(long="--text", value_kind=OperandKind.TEXT),
    Option(long="--text_file", value_kind=OperandKind.PATH),
), )


@command("trello-card-comment-update",
         resource="trello",
         spec=SPEC,
         write=True)
async def trello_card_comment_update(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(_extra, spec=SPEC)
    config = accessor.config
    card_id = _extra.get("card_id")
    if not card_id or not isinstance(card_id, str):
        raise ValueError("--card_id is required")
    comment_id = _extra.get("comment_id")
    if not comment_id or not isinstance(comment_id, str):
        raise ValueError("--comment_id is required")
    text = await resolve_text_input(
        config,
        inline_text=fl.as_str("text"),
        file_path=fl.as_str("text_file"),
        stdin=stdin,
        error_message="comment text is required",
    )
    comment = await comment_update(config,
                                   card_id=card_id,
                                   comment_id=comment_id,
                                   text=text)
    payload = normalize_comment(comment, card_id=card_id)
    return yield_bytes(
        json.dumps(payload, ensure_ascii=False,
                   separators=(",", ":")).encode()), IOResult()
