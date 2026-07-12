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

from functools import partial

from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.trello.trello_card_assign import \
    trello_card_assign
from mirage.commands.builtin.trello.trello_card_comment_add import \
    trello_card_comment_add
from mirage.commands.builtin.trello.trello_card_comment_update import \
    trello_card_comment_update
from mirage.commands.builtin.trello.trello_card_create import \
    trello_card_create
from mirage.commands.builtin.trello.trello_card_label_add import \
    trello_card_label_add
from mirage.commands.builtin.trello.trello_card_label_remove import \
    trello_card_label_remove
from mirage.commands.builtin.trello.trello_card_move import trello_card_move
from mirage.commands.builtin.trello.trello_card_update import \
    trello_card_update
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.core.trello.read import read as _read
from mirage.core.trello.readdir import readdir as _readdir
from mirage.core.trello.stat import stat as _stat

# Trello boards/lists/cards are read through the generic factory (find
# included); the trello_card_*
# commands are the bespoke write/platform surface. The generic byte-mutation
# commands are intentionally absent (mutations go through the platform
# commands, no write op wired).
_TRELLO_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=partial(stream_from_bytes, _read),
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

COMMANDS = [
    *make_generic_commands(
        "trello",
        _TRELLO_CMD_OPS,
    ),
    trello_card_assign,
    trello_card_comment_add,
    trello_card_comment_update,
    trello_card_create,
    trello_card_label_add,
    trello_card_label_remove,
    trello_card_move,
    trello_card_update,
]
