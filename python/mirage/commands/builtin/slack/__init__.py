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

from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.slack.basename import basename
from mirage.commands.builtin.slack.cat import cat
from mirage.commands.builtin.slack.dirname import dirname
from mirage.commands.builtin.slack.find import find
from mirage.commands.builtin.slack.grep import grep
from mirage.commands.builtin.slack.head import head
from mirage.commands.builtin.slack.jq import jq
from mirage.commands.builtin.slack.ls import ls
from mirage.commands.builtin.slack.realpath import realpath
from mirage.commands.builtin.slack.rg import rg
from mirage.commands.builtin.slack.slack_add_reaction import slack_react
from mirage.commands.builtin.slack.slack_get_user_profile import \
    slack_get_user_profile_cmd
from mirage.commands.builtin.slack.slack_get_users import slack_get_users
from mirage.commands.builtin.slack.slack_post_message import slack_post_message
from mirage.commands.builtin.slack.slack_reply_to_thread import slack_reply
from mirage.commands.builtin.slack.slack_search import slack_search
from mirage.commands.builtin.slack.stat import stat
from mirage.commands.builtin.slack.tail import tail
from mirage.commands.builtin.slack.tree import tree
from mirage.commands.builtin.slack.wc import wc
from mirage.core.slack.glob import resolve_glob as _ft_resolve_glob
from mirage.core.slack.read import read as _ft_read

COMMANDS = [
    *make_filetype_commands(
        "slack", _ft_resolve_glob, _ft_read, read_takes_index=True),
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
    slack_post_message,
    slack_reply,
    slack_react,
    slack_get_users,
    slack_get_user_profile_cmd,
    slack_search,
]
