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

from mirage.commands.cli.builtin.discord.delete import delete
from mirage.commands.cli.builtin.discord.edit import edit
from mirage.commands.cli.builtin.discord.members import members
from mirage.commands.cli.builtin.discord.poll import poll
from mirage.commands.cli.builtin.discord.react import react
from mirage.commands.cli.builtin.discord.read import read
from mirage.commands.cli.builtin.discord.search import search
from mirage.commands.cli.builtin.discord.send import send
from mirage.commands.cli.builtin.discord.server_info import server_info
from mirage.commands.cli.builtin.discord.thread_create import thread_create
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.discord.config import DiscordConfig

# The discord program, spelled with the OpenClaw Discord action
# vocabulary (bare verbs: send, read, edit, delete, react, search,
# thread-create, poll). members and server-info are mirage extensions
# carrying over the old mount commands' capabilities. Install with a
# DiscordConfig; two installs are two bots.
DISCORD = CLI(
    spec=CommandSpec(
        name="discord",
        description="Discord REST API client",
        subcommands=(
            CommandSpec(
                name="send",
                description="Send a message to a channel",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--text", required=True),
                    Argument(
                        "--reply-to",
                        help="Reply to this message ID",
                    ),
                ),
            ),
            CommandSpec(
                name="read",
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
                name="edit",
                description="Edit a message the bot authored",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--message", required=True),
                    Argument("--text", required=True),
                ),
            ),
            CommandSpec(
                name="delete",
                description="Delete a message",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--message", required=True),
                ),
            ),
            CommandSpec(
                name="react",
                description="Add an emoji reaction to a message",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--message", required=True),
                    Argument(
                        "--emoji",
                        required=True,
                        help="Unicode emoji or name:id",
                    ),
                ),
            ),
            CommandSpec(
                name="search",
                description="Search a guild's messages by content",
                arguments=(
                    Argument("--guild", required=True),
                    Argument("--query", required=True),
                    Argument("--channel", help="Restrict to one channel"),
                ),
            ),
            CommandSpec(
                name="thread-create",
                description="Create a thread, standalone or from a message",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--name", required=True),
                    Argument(
                        "--message",
                        help="Start the thread from this message",
                    ),
                ),
            ),
            CommandSpec(
                name="poll",
                description="Post a poll message to a channel",
                arguments=(
                    Argument("--channel", required=True),
                    Argument("--question", required=True),
                    Argument(
                        "--answer",
                        action="append",
                        required=True,
                        help="Answer option (repeatable)",
                    ),
                    Argument(
                        "--duration",
                        type="int",
                        help="Poll lifetime in hours (default: 24)",
                    ),
                    Argument(
                        "--multiselect",
                        action="store_true",
                        help="Allow selecting several answers",
                    ),
                ),
            ),
            CommandSpec(
                name="members",
                description="List a guild's members, optionally filtered",
                arguments=(
                    Argument("--guild", required=True),
                    Argument("--query", help="Username prefix filter"),
                ),
            ),
            CommandSpec(
                name="server-info",
                description="Fetch a guild's metadata",
                arguments=(Argument("--guild", required=True),),
            ),
        ),
    ),
    handlers={
        "send": CLIHandler(fn=send, write=True),
        "read": CLIHandler(fn=read),
        "edit": CLIHandler(fn=edit, write=True),
        "delete": CLIHandler(fn=delete, write=True),
        "react": CLIHandler(fn=react, write=True),
        "search": CLIHandler(fn=search),
        "thread-create": CLIHandler(fn=thread_create, write=True),
        "poll": CLIHandler(fn=poll, write=True),
        "members": CLIHandler(fn=members),
        "server-info": CLIHandler(fn=server_info),
    },
    config_model=DiscordConfig,
)
