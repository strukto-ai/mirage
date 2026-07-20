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

from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.builtin.trello.io import IO as _IO
from mirage.commands.builtin.trello.reads import make_trello_read_commands
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

COMMANDS = [
    *make_generic_commands(
        "trello",
        _IO,
    ),
    *make_trello_read_commands(),
    trello_card_assign,
    trello_card_comment_add,
    trello_card_comment_update,
    trello_card_create,
    trello_card_label_add,
    trello_card_label_remove,
    trello_card_move,
    trello_card_update,
]
