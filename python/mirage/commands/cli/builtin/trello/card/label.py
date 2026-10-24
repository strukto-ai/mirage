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

from mirage.accessor.trello import TrelloAccessor
from mirage.commands.cli.builtin.trello.scope import require_card
from mirage.commands.cli.builtin.trello.util import required_flag
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.render.json import compact_json_bytes
from mirage.core.trello.client import card_add_label
from mirage.core.trello.normalize import normalize_card
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def label(
    accessor: TrelloAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    card_id = required_flag(fl, "card_id")
    label_id = required_flag(fl, "label_id")
    await require_card(accessor, card_id)
    card = await card_add_label(accessor, card_id=card_id, label_id=label_id)
    return compact_json_bytes(normalize_card(card)), IOResult()
