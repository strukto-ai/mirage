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

from mirage.commands.cli.builtin.gws.api import api_groups
from mirage.commands.cli.builtin.gws.docs.write import write as docs_write
from mirage.commands.cli.builtin.gws.gmail.forward import forward
from mirage.commands.cli.builtin.gws.gmail.read import read
from mirage.commands.cli.builtin.gws.gmail.reply import reply
from mirage.commands.cli.builtin.gws.gmail.reply_all import reply_all
from mirage.commands.cli.builtin.gws.gmail.send import send
from mirage.commands.cli.builtin.gws.gmail.triage import triage
from mirage.commands.cli.builtin.gws.sheets.append import \
    append as sheets_append
from mirage.commands.cli.builtin.gws.sheets.read import read as sheets_read
from mirage.commands.cli.builtin.gws.sheets.write import write as sheets_write
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Option
from mirage.core.google.config import GoogleConfig
from mirage.types import ResourceName

# The gws program tree, mirroring the official Google Workspace CLI:
# one passthrough leaf per Discovery method (`gws drive files list`,
# speaking --params/--json like the raw API) plus hand-written helper
# verbs directly under their service (`gws gmail send`). The old mount
# registrations spelled the helpers `+send`; the tree does not need the
# marker. Install with a GoogleConfig; two installs are two accounts.
GWS = CLISpec(
    name="gws",
    description="Google Workspace API commands",
    config_model=GoogleConfig,
    serves=(ResourceName.GDRIVE, ResourceName.GDOCS, ResourceName.GSHEETS,
            ResourceName.GSLIDES, ResourceName.GMAIL),
    subcommands=(
        CLISpec(
            name="drive",
            description="Google drive API commands",
            subcommands=api_groups("drive"),
        ),
        CLISpec(
            name="sheets",
            description="Google sheets API commands",
            subcommands=api_groups("sheets") + (
                CLISpec(
                    name="read",
                    description="Read a cell range",
                    fn=sheets_read,
                    options=(
                        Option(long="--spreadsheet", type="str",
                               required=True),
                        Option(long="--range", type="str", required=True),
                    ),
                ),
                CLISpec(
                    name="write",
                    description="Overwrite a range with 2D values",
                    fn=sheets_write,
                    write=True,
                    options=(
                        Option(long="--spreadsheet", type="str",
                               required=True),
                        Option(long="--range", type="str", required=True),
                        Option(long="--values", type="str"),
                        Option(long="--json-values", type="str"),
                    ),
                ),
                CLISpec(
                    name="append",
                    description="Append rows after a range",
                    fn=sheets_append,
                    write=True,
                    options=(
                        Option(long="--spreadsheet", type="str",
                               required=True),
                        Option(long="--range", type="str"),
                        Option(long="--values", type="str"),
                        Option(long="--json-values", type="str"),
                    ),
                ),
            ),
        ),
        CLISpec(
            name="docs",
            description="Google docs API commands",
            subcommands=api_groups("docs") + (CLISpec(
                name="write",
                description="Append text to a document",
                fn=docs_write,
                write=True,
                options=(
                    Option(long="--document", type="str", required=True),
                    Option(long="--text", type="str", required=True),
                ),
            ), ),
        ),
        CLISpec(
            name="slides",
            description="Google slides API commands",
            subcommands=api_groups("slides"),
        ),
        CLISpec(
            name="gmail",
            description="Google gmail API commands",
            subcommands=api_groups("gmail") + (
                CLISpec(
                    name="send",
                    description="Send a new email via Gmail",
                    fn=send,
                    write=True,
                    options=(
                        Option(long="--to", type="str", required=True),
                        Option(long="--subject", type="str", required=True),
                        Option(long="--body", type="str", required=True),
                    ),
                ),
                CLISpec(
                    name="read",
                    description=("Fetch one Gmail message as processed JSON "
                                 "(same shape as cat <path>.gmail.json)"),
                    fn=read,
                    options=(Option(long="--id", type="str", required=True), ),
                ),
                CLISpec(
                    name="reply",
                    description=("Reply to the sender of a Gmail message "
                                 "(excludes CC)"),
                    fn=reply,
                    write=True,
                    options=(
                        Option(long="--message-id", type="str", required=True),
                        Option(long="--body", type="str", required=True),
                    ),
                ),
                CLISpec(
                    name="reply-all",
                    description=("Reply to a Gmail message including all "
                                 "recipients (To+CC)"),
                    fn=reply_all,
                    write=True,
                    options=(
                        Option(long="--message-id", type="str", required=True),
                        Option(long="--body", type="str", required=True),
                    ),
                ),
                CLISpec(
                    name="forward",
                    description="Forward a Gmail message to a new recipient",
                    fn=forward,
                    write=True,
                    options=(
                        Option(long="--message-id", type="str", required=True),
                        Option(long="--to", type="str", required=True),
                    ),
                ),
                CLISpec(
                    name="triage",
                    description=("List message summaries (id, from, subject, "
                                 "date, snippet) for a Gmail search query"),
                    fn=triage,
                    options=(
                        Option(long="--query",
                               type="str",
                               description=("Gmail search query "
                                            '(default: "is:unread")')),
                        Option(long="--max",
                               type="int",
                               description="Max results (default: 20)"),
                    ),
                ),
            ),
        ),
    ),
)
