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

from mirage.commands.cli.builtin.slack.emoji_list import emoji_list
from mirage.commands.cli.builtin.slack.list_members import list_members
from mirage.commands.cli.builtin.slack.list_pins import list_pins
from mirage.commands.cli.builtin.slack.member_info import member_info
from mirage.commands.cli.builtin.slack.pin_message import pin_message
from mirage.commands.cli.builtin.slack.react import react
from mirage.commands.cli.builtin.slack.reactions import reactions
from mirage.commands.cli.builtin.slack.read_messages import read_messages
from mirage.commands.cli.builtin.slack.search import search
from mirage.commands.cli.builtin.slack.send_message import send_message
from mirage.commands.cli.builtin.slack.unpin_message import unpin_message
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Option
from mirage.core.slack.config import SlackConfig

# The slack program, spelled with the OpenClaw Slack action vocabulary
# (kebab verbs: send-message, read-messages, pin-message, list-pins,
# member-info, emoji-list). search and list-members are mirage
# extensions carrying over the old mount commands' capabilities.
# Install with a SlackConfig; two installs are two workspaces.
SLACK = CLISpec(
    name="slack",
    description="Slack Web API client",
    config_model=SlackConfig,
    subcommands=(
        CLISpec(
            name="send-message",
            description="Post a message to a channel or thread",
            fn=send_message,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--text", type="str", required=True),
                Option(long="--thread-ts",
                       type="str",
                       description="Reply in this thread"),
            ),
        ),
        CLISpec(
            name="read-messages",
            description="Read the most recent messages of a channel",
            fn=read_messages,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--limit",
                       type="int",
                       description="Max messages (default: 20)"),
            ),
        ),
        CLISpec(
            name="react",
            description="Add an emoji reaction to a message",
            fn=react,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--ts", type="str", required=True),
                Option(long="--emoji",
                       type="str",
                       required=True,
                       description="Emoji name without colons"),
            ),
        ),
        CLISpec(
            name="reactions",
            description="List the reactions on a message",
            fn=reactions,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--ts", type="str", required=True),
            ),
        ),
        CLISpec(
            name="pin-message",
            description="Pin a message to its channel",
            fn=pin_message,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--ts", type="str", required=True),
            ),
        ),
        CLISpec(
            name="unpin-message",
            description="Remove a pin from a message",
            fn=unpin_message,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--ts", type="str", required=True),
            ),
        ),
        CLISpec(
            name="list-pins",
            description="List the pinned items of a channel",
            fn=list_pins,
            options=(Option(long="--channel", type="str", required=True), ),
        ),
        CLISpec(
            name="member-info",
            description="Fetch one user's profile",
            fn=member_info,
            options=(Option(long="--user", type="str", required=True), ),
        ),
        CLISpec(
            name="list-members",
            description="List workspace members, optionally filtered",
            fn=list_members,
            options=(Option(long="--query",
                            type="str",
                            description="Name or email filter"), ),
        ),
        CLISpec(
            name="emoji-list",
            description="List the workspace's custom emoji",
            fn=emoji_list,
        ),
        CLISpec(
            name="search",
            description="Search messages with Slack query operators",
            fn=search,
            options=(
                Option(long="--query",
                       type="str",
                       required=True,
                       description=("Slack search query (supports operators "
                                    "like 'from:@user', 'in:#channel')")),
                Option(long="--count",
                       type="int",
                       description="Results per page (1-100, default 20)"),
                Option(long="--page",
                       type="int",
                       description="1-based page number (default 1)"),
            ),
        ),
    ),
)
