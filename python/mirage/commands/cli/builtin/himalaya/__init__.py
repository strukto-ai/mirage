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

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.attachment import (
    attachment_download,
    attachment_list,
)
from mirage.commands.cli.builtin.himalaya.compose import compose
from mirage.commands.cli.builtin.himalaya.delete import message_delete
from mirage.commands.cli.builtin.himalaya.flag import (
    flag_add,
    flag_remove,
    flag_set,
)
from mirage.commands.cli.builtin.himalaya.forward import forward
from mirage.commands.cli.builtin.himalaya.list import list_envelopes
from mirage.commands.cli.builtin.himalaya.mailbox import mailbox_list
from mirage.commands.cli.builtin.himalaya.printer import guarded
from mirage.commands.cli.builtin.himalaya.read import read
from mirage.commands.cli.builtin.himalaya.reply import reply
from mirage.commands.cli.builtin.himalaya.search import search_envelopes
from mirage.commands.cli.builtin.himalaya.send import add, send
from mirage.commands.cli.builtin.himalaya.transfer import (
    message_copy,
    message_move,
)
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.core.email.config import EmailConfig

# The himalaya program tree, tracking github.com/pimalaya/himalaya's own
# grammar: `envelope list|search` to triage, `message read/compose/send/
# reply/forward/add` to act. Operand names are upstream's, since a refusal
# for a missing one prints them. Install with a per-account EmailConfig;
# two installs under different head words are two accounts.
JSON = Argument("--json", action="store_true", help="Enable JSON output")
MAILBOX = Argument(
    "-m",
    "--mailbox",
    metavar="NAME",
    help="Mailbox name, alias, role or backend-native id",
)
PAGE = Argument(
    "-p",
    "--page",
    type="int",
    metavar="N",
    help="Page number, starting at 1",
)
PAGE_SIZE = Argument(
    "-s",
    "--page-size",
    type="int",
    metavar="N",
    help="Maximum number of envelopes per page",
)
MAX_WIDTH = Argument(
    "-w",
    "--max-width",
    type="int",
    metavar="COLUMNS",
    help="Maximum width of the rendered table, in terminal columns",
)
RECIPIENT = Argument(
    "-r",
    "--recipient",
    action="store_true",
    help="Render recipients instead of senders",
)
HAS_ATTACHMENT = Argument(
    "--has-attachment", action="store_true", help="Fill the ATT column"
)
MESSAGE_IDS = Argument("MESSAGE-IDS", nargs="*")
MESSAGE_ID = Argument("MESSAGE-ID")
ID = Argument("ID")
RAW_MESSAGE = Argument("MESSAGE", nargs="REMAINDER")
SAVE = Argument(
    "--save",
    metavar="MAILBOX",
    help="Append a copy of the message to this mailbox",
)
NO_SAVE = Argument(
    "--no-save",
    action="store_true",
    help="Skip the copy the account configures",
)

# The built-in flag composer, shared verbatim by compose, reply and
# forward: upstream flattens the same clap struct into all three.
COMPOSER: tuple[Argument, ...] = (
    Argument("--from", metavar="ADDR", help="Sender address"),
    Argument(
        "-t",
        "--to",
        action="append",
        metavar="ADDR",
        help="Recipient addresses, repeatable or comma-separated",
    ),
    Argument(
        "--cc", action="append", metavar="ADDR", help="Carbon-copy recipients"
    ),
    Argument(
        "--bcc",
        action="append",
        metavar="ADDR",
        help="Blind carbon-copy recipients",
    ),
    Argument("-s", "--subject", metavar="TEXT", help="Subject line"),
    Argument("--body", metavar="TEXT", help="Inline body (or pipe via stdin)"),
    Argument(
        "--body-file",
        type="path",
        metavar="PATH",
        help="Read the body from a file",
    ),
    Argument(
        "--attach",
        type="path",
        action="append",
        metavar="PATH",
        help="Files to attach",
    ),
    Argument(
        "--signature",
        metavar="TEXT",
        help="Signature appended after the body",
    ),
    Argument(
        "--signature-file",
        type="path",
        metavar="PATH",
        help="Read the signature from a file",
    ),
    SAVE,
    NO_SAVE,
    Argument(
        "--send",
        action="store_true",
        help="Send the composed message",
    ),
)
QUOTING: tuple[Argument, ...] = (
    Argument(
        "-P",
        "--posting-style",
        choices=("top", "bottom", "none"),
        default="top",
        metavar="STYLE",
        help="Where the quoted source body sits relative to the written one",
    ),
    Argument(
        "-Q",
        "--quote-headline",
        metavar="TEXT",
        help="Plain-text headline placed before the quoted source body",
    ),
)

# Upstream spells both of a message's mailboxes as options on copy and move,
# and takes flags as a repeated option limited to the four every backend has.
SOURCE = Argument(
    "-f", "--from", help="Source mailbox (default: INBOX)", metavar="NAME"
)
TARGET = Argument(
    "-t", "--to", required=True, help="Destination mailbox", metavar="NAME"
)
FLAGS = Argument(
    "-f",
    "--flag",
    action="append",
    required=True,
    choices=("seen", "answered", "flagged", "draft"),
    metavar="FLAG",
    help="The flags to apply, the option repeating for several",
)
ADD_FLAGS = Argument(
    "-f",
    "--flag",
    action="append",
    choices=("seen", "answered", "flagged", "draft"),
    metavar="FLAG",
    help="The flags to set on the added message",
)

HIMALAYA = CLI(
    spec=CommandSpec(
        name="himalaya",
        description="CLI to manage emails",
        usage_style=UsageStyle.CLAP,
        arguments=(JSON,),
        subcommands=(
            CommandSpec(
                name="mailbox",
                description="Manage mailboxes",
                arguments=(JSON,),
                subcommands=(
                    CommandSpec(
                        name="list",
                        aliases=("ls",),
                        description="List the mailboxes of the account",
                        arguments=(
                            JSON,
                            Argument(
                                "--counts",
                                action="store_true",
                                help="Fill the total and unread counts",
                            ),
                            Argument(
                                "-w",
                                "--max-width",
                                type="int",
                                metavar="COLUMNS",
                                help="Maximum width of the rendered table, "
                                "in terminal columns",
                            ),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="flag",
                description="Manage message flags",
                arguments=(JSON,),
                subcommands=(
                    CommandSpec(
                        name="add",
                        description="Add flags to messages",
                        arguments=(JSON, MAILBOX, FLAGS, MESSAGE_IDS),
                    ),
                    CommandSpec(
                        name="set",
                        description="Replace the flags of messages",
                        arguments=(JSON, MAILBOX, FLAGS, MESSAGE_IDS),
                    ),
                    CommandSpec(
                        name="remove",
                        aliases=("rm",),
                        description="Remove flags from messages",
                        arguments=(JSON, MAILBOX, FLAGS, MESSAGE_IDS),
                    ),
                ),
            ),
            CommandSpec(
                name="attachment",
                description="Manage message attachments",
                arguments=(JSON,),
                subcommands=(
                    CommandSpec(
                        name="list",
                        aliases=("ls",),
                        description="List the attachments of one message",
                        arguments=(
                            JSON,
                            MAILBOX,
                            Argument(
                                "-i",
                                "--inline",
                                action="store_true",
                                help="Also list inline parts",
                            ),
                            MESSAGE_ID,
                        ),
                    ),
                    CommandSpec(
                        name="download",
                        aliases=("dl",),
                        description="Save a message's attachments "
                        "to the workspace",
                        arguments=(
                            JSON,
                            MAILBOX,
                            Argument(
                                "-d",
                                "--dir",
                                type="path",
                                metavar="PATH",
                                help="Destination directory (default: cwd)",
                            ),
                            MESSAGE_ID,
                            Argument("ATTACHMENT-ID", nargs="*"),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="envelope",
                description="Manage envelopes",
                arguments=(JSON,),
                subcommands=(
                    CommandSpec(
                        name="list",
                        aliases=("ls",),
                        description="List the envelopes of a mailbox, "
                        "most recent first",
                        arguments=(
                            JSON,
                            MAILBOX,
                            PAGE,
                            PAGE_SIZE,
                            MAX_WIDTH,
                            RECIPIENT,
                            HAS_ATTACHMENT,
                        ),
                    ),
                    CommandSpec(
                        name="search",
                        aliases=("sr",),
                        description="Search envelopes with the query DSL",
                        epilog="Conditions: date <yyyy-mm-dd>, after "
                        "<yyyy-mm-dd>, from <pattern>, to <pattern>, "
                        "subject <pattern>, body <pattern>, flag "
                        "<seen|answered|flagged|draft>. Combine "
                        "with and, or, not; group with parentheses. Sort "
                        "with order by <date|from|to|subject> "
                        "[asc|desc].",
                        arguments=(
                            JSON,
                            MAILBOX,
                            PAGE,
                            PAGE_SIZE,
                            MAX_WIDTH,
                            RECIPIENT,
                            HAS_ATTACHMENT,
                            Argument("QUERY", nargs="*"),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="message",
                aliases=("msg",),
                description="Manage messages",
                arguments=(JSON,),
                subcommands=(
                    CommandSpec(
                        name="copy",
                        aliases=("cp",),
                        description="Copy messages to another mailbox",
                        arguments=(JSON, SOURCE, TARGET, MESSAGE_IDS),
                    ),
                    CommandSpec(
                        name="move",
                        aliases=("mv",),
                        description="Move messages to another mailbox",
                        arguments=(JSON, SOURCE, TARGET, MESSAGE_IDS),
                    ),
                    CommandSpec(
                        name="delete",
                        aliases=("rm",),
                        description="Move messages to the trash, or remove "
                        "them once they are there",
                        arguments=(JSON, MAILBOX, MESSAGE_IDS),
                    ),
                    CommandSpec(
                        name="read",
                        description="Read a message",
                        arguments=(
                            JSON,
                            MAILBOX,
                            Argument(
                                "--raw",
                                action="store_true",
                                help="Write the raw RFC 5322 bytes to stdout",
                            ),
                            Argument(
                                "--seen",
                                action="store_true",
                                help="Mark the message as seen",
                            ),
                            ID,
                        ),
                    ),
                    CommandSpec(
                        name="compose",
                        aliases=("write", "new"),
                        description="Compose a new message from flags",
                        arguments=(JSON, *COMPOSER),
                    ),
                    CommandSpec(
                        name="send",
                        description="Send a message through the account",
                        arguments=(JSON, SAVE, NO_SAVE, RAW_MESSAGE),
                    ),
                    CommandSpec(
                        name="add",
                        aliases=("save",),
                        description="Add a raw RFC 5322 message to a mailbox",
                        arguments=(
                            JSON,
                            Argument(
                                "-m",
                                "--mailbox",
                                required=True,
                                metavar="NAME",
                                help="Mailbox to add the message to",
                            ),
                            ADD_FLAGS,
                            Argument(
                                "--send",
                                action="store_true",
                                help="Also send the message",
                            ),
                            RAW_MESSAGE,
                        ),
                    ),
                    CommandSpec(
                        name="reply",
                        description="Reply to a message",
                        arguments=(
                            JSON,
                            MAILBOX,
                            *COMPOSER,
                            *QUOTING,
                            ID,
                        ),
                    ),
                    CommandSpec(
                        name="forward",
                        aliases=("fwd",),
                        description="Forward a message",
                        arguments=(
                            JSON,
                            MAILBOX,
                            *COMPOSER,
                            *QUOTING,
                            ID,
                        ),
                    ),
                ),
            ),
        ),
    ),
    handlers={
        "mailbox list": CLIHandler(fn=guarded(mailbox_list)),
        "flag add": CLIHandler(fn=guarded(flag_add), write=True),
        "flag set": CLIHandler(fn=guarded(flag_set), write=True),
        "flag remove": CLIHandler(fn=guarded(flag_remove), write=True),
        "attachment list": CLIHandler(fn=guarded(attachment_list)),
        "attachment download": CLIHandler(
            fn=guarded(attachment_download), write=True
        ),
        "message copy": CLIHandler(fn=guarded(message_copy), write=True),
        "message move": CLIHandler(fn=guarded(message_move), write=True),
        "message delete": CLIHandler(fn=guarded(message_delete), write=True),
        "envelope list": CLIHandler(fn=guarded(list_envelopes)),
        "envelope search": CLIHandler(fn=guarded(search_envelopes)),
        "message read": CLIHandler(fn=guarded(read), write_when=("--seen",)),
        "message compose": CLIHandler(fn=guarded(compose), write=True),
        "message send": CLIHandler(fn=guarded(send), write=True),
        "message add": CLIHandler(fn=guarded(add), write=True),
        "message reply": CLIHandler(fn=guarded(reply), write=True),
        "message forward": CLIHandler(fn=guarded(forward), write=True),
    },
    config_model=EmailConfig,
    accessor=EmailAccessor,
)
