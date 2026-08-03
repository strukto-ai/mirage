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

from mirage.commands.cli.builtin.himalaya.forward import forward
from mirage.commands.cli.builtin.himalaya.list import list_envelopes
from mirage.commands.cli.builtin.himalaya.read import read
from mirage.commands.cli.builtin.himalaya.reply import reply
from mirage.commands.cli.builtin.himalaya.send import send
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Option
from mirage.resource.email.config import EmailConfig

# The himalaya program tree (github.com/pimalaya/himalaya vocabulary):
# `envelope list` to triage, `message read/send/reply/forward` to act.
# Install with a per-account EmailConfig; two installs under different
# head words are two accounts.
HIMALAYA = CLISpec(
    name="himalaya",
    description="IMAP/SMTP mail client",
    config_model=EmailConfig,
    subcommands=(
        CLISpec(
            name="envelope",
            description="Manage envelopes",
            subcommands=(CLISpec(
                name="list",
                description="List envelopes as JSON headers",
                fn=list_envelopes,
                options=(
                    Option(long="--folder", type="str"),
                    Option(long="--max", type="int"),
                    Option(long="--unseen"),
                    Option(long="--subject", type="str"),
                    Option(long="--from", type="str"),
                    Option(long="--to", type="str"),
                    Option(long="--body", type="str"),
                    Option(long="--since", type="str"),
                    Option(long="--before", type="str"),
                ),
            ), ),
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
                        Option(long="--uid", type="str", required=True),
                        Option(long="--folder", type="str", required=True),
                    ),
                ),
                CLISpec(
                    name="send",
                    description="Send a new message",
                    fn=send,
                    write=True,
                    options=(
                        Option(long="--to", type="str", required=True),
                        Option(long="--subject", type="str", required=True),
                        Option(long="--body", type="str", required=True),
                    ),
                ),
                CLISpec(
                    name="reply",
                    description="Reply to a message",
                    fn=reply,
                    write=True,
                    options=(
                        Option(long="--uid", type="str", required=True),
                        Option(long="--folder", type="str", required=True),
                        Option(long="--body", type="str", required=True),
                        Option(long="--all"),
                    ),
                ),
                CLISpec(
                    name="forward",
                    description="Forward a message",
                    fn=forward,
                    write=True,
                    options=(
                        Option(long="--uid", type="str", required=True),
                        Option(long="--folder", type="str", required=True),
                        Option(long="--to", type="str", required=True),
                    ),
                ),
            ),
        ),
    ),
)
