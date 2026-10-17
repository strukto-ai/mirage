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
from mirage.commands.cli.builtin.trello import reads
from mirage.commands.cli.builtin.trello.card.assign import assign
from mirage.commands.cli.builtin.trello.card.comment import comment
from mirage.commands.cli.builtin.trello.card.comment_update import (
    comment_update,
)
from mirage.commands.cli.builtin.trello.card.create import create
from mirage.commands.cli.builtin.trello.card.label import label
from mirage.commands.cli.builtin.trello.card.move import move
from mirage.commands.cli.builtin.trello.card.unlabel import unlabel
from mirage.commands.cli.builtin.trello.card.update import update
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.trello.config import TrelloConfig

ARG = Argument("texts", nargs="*", metavar="")

CARD_ID = Argument("--card_id", help="Trello card ID")

LIST_ID = Argument("--list_id", help="Trello list ID")

LABEL_ID = Argument("--label_id", help="Trello label ID")

DESC = Argument("--desc", help="Inline description text")

DESC_FILE = Argument(
    "--desc_file", type="path", help="Path to file containing description"
)

TEXT = Argument("--text", help="Inline comment text")

TEXT_FILE = Argument(
    "--text_file", type="path", help="Path to file containing text"
)

TRELLO = CLI(
    spec=CommandSpec(
        name="trello",
        description="Trello REST API client",
        subcommands=(
            CommandSpec(
                name="board",
                description="Read boards",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List the boards in scope as JSON",
                    ),
                    CommandSpec(
                        name="show",
                        description="Get one board by ID",
                        arguments=(ARG,),
                    ),
                    CommandSpec(
                        name="members",
                        description="List a board's members",
                        arguments=(ARG,),
                    ),
                ),
            ),
            CommandSpec(
                name="list",
                description="Read lists",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a board's lists",
                        arguments=(ARG,),
                    ),
                ),
            ),
            CommandSpec(
                name="label",
                description="Read labels",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a board's labels",
                        arguments=(ARG,),
                    ),
                ),
            ),
            CommandSpec(
                name="card",
                description="Manage cards",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List the cards in a list",
                        arguments=(ARG,),
                    ),
                    CommandSpec(
                        name="show",
                        description="Get one card by ID",
                        arguments=(ARG,),
                    ),
                    CommandSpec(
                        name="comments",
                        description="List a card's comments",
                        arguments=(ARG,),
                    ),
                    CommandSpec(
                        name="create",
                        description="Create a new card",
                        arguments=(
                            LIST_ID,
                            Argument("--name", help="Card name"),
                            DESC,
                            DESC_FILE,
                        ),
                    ),
                    CommandSpec(
                        name="update",
                        description="Update an existing card",
                        arguments=(
                            CARD_ID,
                            Argument("--name", help="New card name"),
                            DESC,
                            DESC_FILE,
                            Argument("--due", help="Due date"),
                            Argument(
                                "--closed", help="Archive card (true/false)"
                            ),
                        ),
                    ),
                    CommandSpec(
                        name="move",
                        description="Move a card to a different list",
                        arguments=(CARD_ID, LIST_ID),
                    ),
                    CommandSpec(
                        name="assign",
                        description="Assign a member to a card",
                        arguments=(
                            CARD_ID,
                            Argument("--member_id", help="Trello member ID"),
                        ),
                    ),
                    CommandSpec(
                        name="label",
                        description="Add a label to a card",
                        arguments=(CARD_ID, LABEL_ID),
                    ),
                    CommandSpec(
                        name="unlabel",
                        description="Remove a label from a card",
                        arguments=(CARD_ID, LABEL_ID),
                    ),
                    CommandSpec(
                        name="comment",
                        description="Add a comment to a card",
                        arguments=(CARD_ID, TEXT, TEXT_FILE),
                    ),
                    CommandSpec(
                        name="comment-update",
                        description="Update an existing comment",
                        arguments=(
                            CARD_ID,
                            Argument("--comment_id", help="Trello comment ID"),
                            TEXT,
                            TEXT_FILE,
                        ),
                    ),
                ),
            ),
        ),
    ),
    handlers={
        "board list": CLIHandler(fn=reads.board_list),
        "board show": CLIHandler(fn=reads.board_show),
        "board members": CLIHandler(fn=reads.board_members),
        "list list": CLIHandler(fn=reads.list_list),
        "label list": CLIHandler(fn=reads.label_list),
        "card list": CLIHandler(fn=reads.card_list),
        "card show": CLIHandler(fn=reads.card_show),
        "card comments": CLIHandler(fn=reads.card_comments),
        "card create": CLIHandler(fn=create, write=True),
        "card update": CLIHandler(fn=update, write=True),
        "card move": CLIHandler(fn=move, write=True),
        "card assign": CLIHandler(fn=assign, write=True),
        "card label": CLIHandler(fn=label, write=True),
        "card unlabel": CLIHandler(fn=unlabel, write=True),
        "card comment": CLIHandler(fn=comment, write=True),
        "card comment-update": CLIHandler(fn=comment_update, write=True),
    },
    config_model=TrelloConfig,
    accessor=TrelloAccessor,
)
