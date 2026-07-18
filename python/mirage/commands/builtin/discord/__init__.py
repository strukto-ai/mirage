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

from mirage.commands.builtin.discord.discord_add_reaction import \
    discord_add_reaction
from mirage.commands.builtin.discord.discord_get_server_info import \
    discord_get_server_info
from mirage.commands.builtin.discord.discord_list_members import \
    discord_list_members
from mirage.commands.builtin.discord.discord_send_message import \
    discord_send_message
from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.head import head
from mirage.commands.builtin.discord.ops import OPS as _DISCORD_CMD_OPS
from mirage.commands.builtin.discord.rg import rg
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.core.discord.read import read as _read

COMMANDS = [
    *make_filetype_commands(
        "discord", _DISCORD_CMD_OPS.resolve_glob, _read,
        read_takes_index=True),
    *make_generic_commands(
        "discord",
        _DISCORD_CMD_OPS,
        overrides={"grep", "rg", "head"},
    ),
    grep,
    rg,
    head,
    discord_send_message,
    discord_add_reaction,
    discord_list_members,
    discord_get_server_info,
]
