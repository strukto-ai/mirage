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
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.slack.config import SlackConfig

# The slack program, spelled with the OpenClaw Slack action vocabulary
# (kebab verbs: send-message, read-messages, pin-message, list-pins,
# member-info, emoji-list). search and list-members are mirage
# extensions carrying over the old mount commands' capabilities.
# Install with a SlackConfig; two installs are two workspaces.
SLACK = CLI(
    spec=CommandSpec(
        name="slack",
        description="Slack Web API client",
        subcommands=(
            CommandSpec(
                name="send-message",
                description="Post a message to a channel or thread",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--text", required=True),
                    Argument("--thread-ts", help="Reply in this thread"),
                ),
            ),
            CommandSpec(
                name="read-messages",
                description="Read the most recent messages of a channel",
                arguments=(
                    Argument("--channel", required=True),
                    Argument(
                        "--limit",
                        type="int",
                        help="Max messages (default: 20)",
                    ),
                ),
            ),
            CommandSpec(
                name="react",
                description="Add an emoji reaction to a message",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--ts", required=True),
                    Argument(
                        "--emoji",
                        required=True,
                        help="Emoji name without colons",
                    ),
                ),
            ),
            CommandSpec(
                name="reactions",
                description="List the reactions on a message",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--ts", required=True),
                ),
            ),
            CommandSpec(
                name="pin-message",
                description="Pin a message to its channel",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--ts", required=True),
                ),
            ),
            CommandSpec(
                name="unpin-message",
                description="Remove a pin from a message",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--ts", required=True),
                ),
            ),
            CommandSpec(
                name="list-pins",
                description="List the pinned items of a channel",
                arguments=(Argument("--channel", required=True),),
            ),
            CommandSpec(
                name="member-info",
                description="Fetch one user's profile",
                arguments=(Argument("--user", required=True),),
            ),
            CommandSpec(
                name="list-members",
                description="List workspace members, optionally filtered",
                arguments=(Argument("--query", help="Name or email filter"),),
            ),
            CommandSpec(
                name="emoji-list",
                description="List the workspace's custom emoji",
            ),
            CommandSpec(
                name="search",
                description="Search messages with Slack query operators",
                arguments=(
                    Argument(
                        "--query",
                        required=True,
                        help="Slack search query (supports operators "
                        "like 'from:@user', 'in:#channel')",
                    ),
                    Argument(
                        "--count",
                        type="int",
                        help="Results per page (1-100, default 20)",
                    ),
                    Argument(
                        "--page",
                        type="int",
                        help="1-based page number (default 1)",
                    ),
                ),
            ),
        ),
    ),
    handlers={
        "send-message": CLIHandler(fn=send_message, write=True),
        "read-messages": CLIHandler(fn=read_messages),
        "react": CLIHandler(fn=react, write=True),
        "reactions": CLIHandler(fn=reactions),
        "pin-message": CLIHandler(fn=pin_message, write=True),
        "unpin-message": CLIHandler(fn=unpin_message, write=True),
        "list-pins": CLIHandler(fn=list_pins),
        "member-info": CLIHandler(fn=member_info),
        "list-members": CLIHandler(fn=list_members),
        "emoji-list": CLIHandler(fn=emoji_list),
        "search": CLIHandler(fn=search),
    },
    config_model=SlackConfig,
)
