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
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Option
from mirage.core.discord.config import DiscordConfig

# The discord program, spelled with the OpenClaw Discord action
# vocabulary (bare verbs: send, read, edit, delete, react, search,
# thread-create, poll). members and server-info are mirage extensions
# carrying over the old mount commands' capabilities. Install with a
# DiscordConfig; two installs are two bots.
DISCORD = CLISpec(
    name="discord",
    description="Discord REST API client",
    config_model=DiscordConfig,
    subcommands=(
        CLISpec(
            name="send",
            description="Send a message to a channel",
            fn=send,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--text", type="str", required=True),
                Option(long="--reply-to",
                       type="str",
                       description="Reply to this message ID"),
            ),
        ),
        CLISpec(
            name="read",
            description="Read the most recent messages of a channel",
            fn=read,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--limit",
                       type="int",
                       description="Max messages (default: 20)"),
            ),
        ),
        CLISpec(
            name="edit",
            description="Edit a message the bot authored",
            fn=edit,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--message", type="str", required=True),
                Option(long="--text", type="str", required=True),
            ),
        ),
        CLISpec(
            name="delete",
            description="Delete a message",
            fn=delete,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--message", type="str", required=True),
            ),
        ),
        CLISpec(
            name="react",
            description="Add an emoji reaction to a message",
            fn=react,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--message", type="str", required=True),
                Option(long="--emoji",
                       type="str",
                       required=True,
                       description="Unicode emoji or name:id"),
            ),
        ),
        CLISpec(
            name="search",
            description="Search a guild's messages by content",
            fn=search,
            options=(
                Option(long="--guild", type="str", required=True),
                Option(long="--query", type="str", required=True),
                Option(long="--channel",
                       type="str",
                       description="Restrict to one channel"),
            ),
        ),
        CLISpec(
            name="thread-create",
            description="Create a thread, standalone or from a message",
            fn=thread_create,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--name", type="str", required=True),
                Option(long="--message",
                       type="str",
                       description="Start the thread from this message"),
            ),
        ),
        CLISpec(
            name="poll",
            description="Post a poll message to a channel",
            fn=poll,
            write=True,
            options=(
                Option(long="--channel", type="str", required=True),
                Option(long="--question", type="str", required=True),
                Option(long="--answer",
                       type="str",
                       required=True,
                       multiple=True,
                       description="Answer option (repeatable)"),
                Option(long="--duration",
                       type="int",
                       description="Poll lifetime in hours (default: 24)"),
                Option(long="--multiselect",
                       description="Allow selecting several answers"),
            ),
        ),
        CLISpec(
            name="members",
            description="List a guild's members, optionally filtered",
            fn=members,
            options=(
                Option(long="--guild", type="str", required=True),
                Option(long="--query",
                       type="str",
                       description="Username prefix filter"),
            ),
        ),
        CLISpec(
            name="server-info",
            description="Fetch a guild's metadata",
            fn=server_info,
            options=(Option(long="--guild", type="str", required=True), ),
        ),
    ),
)
