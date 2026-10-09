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

from mirage.commands.cli.builtin.gws.api import api_groups, api_handlers
from mirage.commands.cli.builtin.gws.docs.write import write as docs_write
from mirage.commands.cli.builtin.gws.gmail.forward import forward
from mirage.commands.cli.builtin.gws.gmail.read import read
from mirage.commands.cli.builtin.gws.gmail.reply import reply
from mirage.commands.cli.builtin.gws.gmail.reply_all import reply_all
from mirage.commands.cli.builtin.gws.gmail.send import send
from mirage.commands.cli.builtin.gws.gmail.triage import triage
from mirage.commands.cli.builtin.gws.sheets.append import (
    append as sheets_append,
)
from mirage.commands.cli.builtin.gws.sheets.read import read as sheets_read
from mirage.commands.cli.builtin.gws.sheets.write import write as sheets_write
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.google.config import GoogleConfig

# The gws program tree, mirroring the official Google Workspace CLI:
# one passthrough leaf per Discovery method (`gws drive files list`,
# speaking --params/--json like the raw API) plus hand-written helper
# verbs directly under their service (`gws gmail send`). The old mount
# registrations spelled the helpers `+send`; the tree does not need the
# marker. Install with a GoogleConfig; two installs are two accounts.
GWS = CLI(
    spec=CommandSpec(
        name="gws",
        description="Google Workspace API commands",
        subcommands=(
            CommandSpec(
                name="drive",
                description="Google drive API commands",
                subcommands=api_groups("drive"),
            ),
            CommandSpec(
                name="sheets",
                description="Google sheets API commands",
                subcommands=api_groups("sheets")
                + (
                    CommandSpec(
                        name="read",
                        description="Read a cell range",
                        arguments=(
                            Argument("--spreadsheet", required=True),
                            Argument("--range", required=True),
                        ),
                    ),
                    CommandSpec(
                        name="write",
                        description="Overwrite a range with 2D values",
                        arguments=(
                            Argument("--spreadsheet", required=True),
                            Argument("--range", required=True),
                            Argument("--values"),
                            Argument("--json-values"),
                        ),
                    ),
                    CommandSpec(
                        name="append",
                        description="Append rows after a range",
                        arguments=(
                            Argument("--spreadsheet", required=True),
                            Argument("--range"),
                            Argument("--values"),
                            Argument("--json-values"),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="docs",
                description="Google docs API commands",
                subcommands=api_groups("docs")
                + (
                    CommandSpec(
                        name="write",
                        description="Append text to a document",
                        arguments=(
                            Argument("--document", required=True),
                            Argument("--text", required=True),
                            Argument(
                                "--tab",
                                help="Tab to append to, from "
                                "tabs[].tabProperties.tabId; "
                                "the first tab when omitted",
                            ),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="slides",
                description="Google slides API commands",
                subcommands=api_groups("slides"),
            ),
            CommandSpec(
                name="calendar",
                description="Google calendar API commands",
                subcommands=api_groups("calendar"),
            ),
            CommandSpec(
                name="forms",
                description="Google forms API commands",
                subcommands=api_groups("forms"),
            ),
            CommandSpec(
                name="gmail",
                description="Google gmail API commands",
                subcommands=api_groups("gmail")
                + (
                    CommandSpec(
                        name="send",
                        description="Send a new email via Gmail",
                        arguments=(
                            Argument("--to", required=True),
                            Argument("--subject", required=True),
                            Argument("--body", required=True),
                        ),
                    ),
                    CommandSpec(
                        name="read",
                        description="Fetch one Gmail message as processed JSON "
                        "(same shape as cat <path>.gmail.json)",
                        arguments=(Argument("--id", required=True),),
                    ),
                    CommandSpec(
                        name="reply",
                        description=(
                            "Reply to the sender of a Gmail message "
                            "(excludes CC)"
                        ),
                        arguments=(
                            Argument("--message-id", required=True),
                            Argument("--body", required=True),
                        ),
                    ),
                    CommandSpec(
                        name="reply-all",
                        description="Reply to a Gmail message including all "
                        "recipients (To+CC)",
                        arguments=(
                            Argument("--message-id", required=True),
                            Argument("--body", required=True),
                        ),
                    ),
                    CommandSpec(
                        name="forward",
                        description="Forward a Gmail message to a new recipient",
                        arguments=(
                            Argument("--message-id", required=True),
                            Argument("--to", required=True),
                        ),
                    ),
                    CommandSpec(
                        name="triage",
                        description="List message summaries (id, from, subject, "
                        "date, snippet) for a Gmail search query",
                        arguments=(
                            Argument(
                                "--query",
                                help='Gmail search query (default: "is:unread")',
                            ),
                            Argument(
                                "--max",
                                type="int",
                                help="Max results (default: 20)",
                            ),
                        ),
                    ),
                ),
            ),
        ),
    ),
    handlers={
        **api_handlers(),
        "sheets read": CLIHandler(fn=sheets_read),
        "sheets write": CLIHandler(fn=sheets_write, write=True),
        "sheets append": CLIHandler(fn=sheets_append, write=True),
        "docs write": CLIHandler(fn=docs_write, write=True),
        "gmail send": CLIHandler(fn=send, write=True),
        "gmail read": CLIHandler(fn=read),
        "gmail reply": CLIHandler(fn=reply, write=True),
        "gmail reply-all": CLIHandler(fn=reply_all, write=True),
        "gmail forward": CLIHandler(fn=forward, write=True),
        "gmail triage": CLIHandler(fn=triage),
    },
    config_model=GoogleConfig,
)
