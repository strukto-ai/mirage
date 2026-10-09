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

from mirage.commands.cli.builtin.himalaya.compose import compose
from mirage.commands.cli.builtin.himalaya.forward import forward
from mirage.commands.cli.builtin.himalaya.list import list_envelopes
from mirage.commands.cli.builtin.himalaya.read import read
from mirage.commands.cli.builtin.himalaya.reply import reply
from mirage.commands.cli.builtin.himalaya.search import search_envelopes
from mirage.commands.cli.builtin.himalaya.send import send
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.email.config import EmailConfig

# The himalaya program tree, tracking github.com/pimalaya/himalaya's own
# grammar: `envelope list|search` to triage, `message read/compose/send/
# reply/forward` to act. Messages are addressed by positional id, the
# mailbox by -m/--mailbox, and the built-in flag composer writes RFC 5322
# to stdout unless --send is passed. Install with a per-account
# EmailConfig; two installs under different head words are two accounts.
ID = Argument("text", nargs="*", metavar="")
MAILBOX = Argument("-m", "--mailbox", help="Mailbox name (default: INBOX)")
PAGE = Argument(
    "-p", "--page", type="int", help="Page number, starting from 1"
)
PAGE_SIZE = Argument(
    "-s", "--page-size", type="int", help="Maximum envelopes per page"
)

# Upstream v2 spells the sent copy as an explicit mailbox on every verb
# that produces a message, so `--save` alone files it without sending and
# `--save` with `--send` does both, naming the mailbox the account's
# save_copy would otherwise resolve on its own.
SAVE = Argument(
    "--save",
    metavar="MAILBOX",
    help="Append a copy of the message to this mailbox",
)

# The built-in flag composer, shared verbatim by compose, reply and
# forward: upstream flattens the same clap struct into all three.
COMPOSER: tuple[Argument, ...] = (
    Argument("--from", help="Sender address"),
    Argument(
        "-t",
        "--to",
        action="append",
        help="Recipient address(es), repeatable or comma-separated",
    ),
    Argument("--cc", action="append", help="Carbon-copy recipient(s)"),
    Argument(
        "--bcc",
        action="append",
        help="Blind carbon-copy recipient(s)",
    ),
    Argument("-s", "--subject", help="Subject line"),
    Argument("--body", help="Inline body (or pipe via stdin)"),
    Argument(
        "--attach",
        type="path",
        action="append",
        help="Attachment file(s), repeatable",
    ),
    Argument("--signature", help="Signature appended after a '-- ' line"),
    Argument(
        "--send",
        action="store_true",
        help="Send through SMTP instead of writing MIME to stdout",
    ),
    SAVE,
)
QUOTING: tuple[Argument, ...] = (
    Argument(
        "-P",
        "--posting-style",
        choices=("top", "bottom"),
        default="top",
        help="Quoted source above or below your body",
    ),
    Argument(
        "-Q",
        "--quote-headline",
        help="Literal line placed before the quoted body",
    ),
)

HIMALAYA = CLI(
    spec=CommandSpec(
        name="himalaya",
        description="IMAP/SMTP mail client",
        subcommands=(
            CommandSpec(
                name="envelope",
                description="Manage envelopes",
                subcommands=(
                    CommandSpec(
                        name="list",
                        aliases=("ls",),
                        description="List envelopes as JSON headers",
                        arguments=(
                            MAILBOX,
                            PAGE,
                            PAGE_SIZE,
                        ),
                    ),
                    CommandSpec(
                        name="search",
                        aliases=("sr",),
                        description="Search envelopes with the query DSL",
                        epilog="Conditions: date <yyyy-mm-dd>, before "
                        "<yyyy-mm-dd>, after <yyyy-mm-dd>, from "
                        "<pattern>, to <pattern>, subject <pattern>, "
                        "body <pattern>, flag "
                        "<seen|answered|flagged|draft|deleted>. Combine "
                        "with and, or, not; group with parentheses. Sort "
                        "with order by <date|from|to|subject> "
                        "[asc|desc].",
                        arguments=(
                            MAILBOX,
                            PAGE,
                            PAGE_SIZE,
                            ID,
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="message",
                description="Manage messages",
                subcommands=(
                    CommandSpec(
                        name="read",
                        description="Read one message as JSON",
                        arguments=(
                            MAILBOX,
                            Argument(
                                "--raw",
                                action="store_true",
                                help="Write the RFC 5322 bytes instead",
                            ),
                            ID,
                        ),
                    ),
                    CommandSpec(
                        name="compose",
                        aliases=("write", "new"),
                        description="Compose a new message from flags",
                        arguments=(*COMPOSER,),
                    ),
                    CommandSpec(
                        name="send",
                        description="Send a raw RFC 5322 message",
                        arguments=(
                            SAVE,
                            ID,
                        ),
                    ),
                    CommandSpec(
                        name="reply",
                        description="Reply to a message",
                        arguments=(
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
        "envelope list": CLIHandler(fn=list_envelopes),
        "envelope search": CLIHandler(fn=search_envelopes),
        "message read": CLIHandler(fn=read),
        "message compose": CLIHandler(fn=compose, write=True),
        "message send": CLIHandler(fn=send, write=True),
        "message reply": CLIHandler(fn=reply, write=True),
        "message forward": CLIHandler(fn=forward, write=True),
    },
    config_model=EmailConfig,
)
