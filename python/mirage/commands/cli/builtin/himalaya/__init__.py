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
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Operand, Option
from mirage.core.email.config import EmailConfig

# The himalaya program tree, tracking github.com/pimalaya/himalaya's own
# grammar: `envelope list|search` to triage, `message read/compose/send/
# reply/forward` to act. Messages are addressed by positional id, the
# mailbox by -m/--mailbox, and the built-in flag composer writes RFC 5322
# to stdout unless --send is passed. Install with a per-account
# EmailConfig; two installs under different head words are two accounts.
ID = Operand(type="str")
MAILBOX = Option(short="-m",
                 long="--mailbox",
                 type="str",
                 description="Mailbox name (default: INBOX)")
PAGE = Option(short="-p",
              long="--page",
              type="int",
              description="Page number, starting from 1")
PAGE_SIZE = Option(short="-s",
                   long="--page-size",
                   type="int",
                   description="Maximum envelopes per page")

# The built-in flag composer, shared verbatim by compose, reply and
# forward: upstream flattens the same clap struct into all three.
COMPOSER: tuple[Option, ...] = (
    Option(long="--from", type="str", description="Sender address"),
    Option(short="-t",
           long="--to",
           type="str",
           multiple=True,
           description="Recipient address(es), repeatable or comma-separated"),
    Option(long="--cc",
           type="str",
           multiple=True,
           description="Carbon-copy recipient(s)"),
    Option(long="--bcc",
           type="str",
           multiple=True,
           description="Blind carbon-copy recipient(s)"),
    Option(short="-s",
           long="--subject",
           type="str",
           description="Subject line"),
    Option(long="--body",
           type="str",
           description="Inline body (or pipe via stdin)"),
    Option(long="--attach",
           type="path",
           multiple=True,
           description="Attachment file(s), repeatable"),
    Option(long="--signature",
           type="str",
           description="Signature appended after a '-- ' line"),
    Option(long="--send",
           description="Send through SMTP instead of writing MIME to stdout"),
)
QUOTING: tuple[Option, ...] = (
    Option(short="-P",
           long="--posting-style",
           type="str",
           choices=("top", "bottom"),
           default="top",
           description="Quoted source above or below your body"),
    Option(short="-Q",
           long="--quote-headline",
           type="str",
           description="Literal line placed before the quoted body"),
)

HIMALAYA = CLISpec(
    name="himalaya",
    description="IMAP/SMTP mail client",
    config_model=EmailConfig,
    subcommands=(
        CLISpec(
            name="envelope",
            description="Manage envelopes",
            subcommands=(
                CLISpec(
                    name="list",
                    aliases=("ls", ),
                    description="List envelopes as JSON headers",
                    fn=list_envelopes,
                    options=(MAILBOX, PAGE, PAGE_SIZE),
                ),
                CLISpec(
                    name="search",
                    aliases=("sr", ),
                    description="Search envelopes with the query DSL",
                    fn=search_envelopes,
                    options=(MAILBOX, PAGE, PAGE_SIZE),
                    rest=ID,
                    epilog=("Conditions: date <yyyy-mm-dd>, before "
                            "<yyyy-mm-dd>, after <yyyy-mm-dd>, from "
                            "<pattern>, to <pattern>, subject <pattern>, "
                            "body <pattern>, flag "
                            "<seen|answered|flagged|draft|deleted>. Combine "
                            "with and, or, not; group with parentheses. Sort "
                            "with order by <date|from|to|subject> "
                            "[asc|desc]."),
                ),
            ),
        ),
        CLISpec(
            name="message",
            description="Manage messages",
            subcommands=(
                CLISpec(
                    name="read",
                    description="Read one message as JSON",
                    fn=read,
                    options=(
                        MAILBOX,
                        Option(long="--raw",
                               description="Write the RFC 5322 bytes instead"),
                    ),
                    rest=ID,
                ),
                CLISpec(
                    name="compose",
                    aliases=("write", "new"),
                    description="Compose a new message from flags",
                    fn=compose,
                    write=True,
                    options=COMPOSER,
                ),
                CLISpec(
                    name="send",
                    description="Send a raw RFC 5322 message",
                    fn=send,
                    write=True,
                    rest=ID,
                ),
                CLISpec(
                    name="reply",
                    description="Reply to a message",
                    fn=reply,
                    write=True,
                    options=(MAILBOX, *COMPOSER, *QUOTING),
                    rest=ID,
                ),
                CLISpec(
                    name="forward",
                    aliases=("fwd", ),
                    description="Forward a message",
                    fn=forward,
                    write=True,
                    options=(MAILBOX, *COMPOSER, *QUOTING),
                    rest=ID,
                ),
            ),
        ),
    ),
)
