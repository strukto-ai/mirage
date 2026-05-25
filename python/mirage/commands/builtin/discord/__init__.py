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

from mirage.commands.builtin.discord.basename import basename
from mirage.commands.builtin.discord.cat import cat
from mirage.commands.builtin.discord.dirname import dirname
from mirage.commands.builtin.discord.discord_add_reaction import \
    discord_add_reaction
from mirage.commands.builtin.discord.discord_get_server_info import \
    discord_get_server_info
from mirage.commands.builtin.discord.discord_list_members import \
    discord_list_members
from mirage.commands.builtin.discord.discord_send_message import \
    discord_send_message
from mirage.commands.builtin.discord.find import find
from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.head import head
from mirage.commands.builtin.discord.jq import jq
from mirage.commands.builtin.discord.ls import ls
from mirage.commands.builtin.discord.realpath import realpath
from mirage.commands.builtin.discord.rg import rg
from mirage.commands.builtin.discord.stat import stat
from mirage.commands.builtin.discord.tail import tail
from mirage.commands.builtin.discord.tree import tree
from mirage.commands.builtin.discord.wc import wc
from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.core.discord.glob import resolve_glob as _ft_resolve_glob
from mirage.core.discord.read import read as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "discord", _ft_resolve_glob, _ft_read, read_takes_index=True),
    basename,
    cat,
    dirname,
    find,
    grep,
    head,
    jq,
    ls,
    realpath,
    rg,
    stat,
    tail,
    tree,
    wc,
    discord_send_message,
    discord_add_reaction,
    discord_list_members,
    discord_get_server_info,
]
