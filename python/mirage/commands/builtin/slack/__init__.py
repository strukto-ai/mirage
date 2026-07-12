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
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.slack.grep import grep
from mirage.commands.builtin.slack.rg import rg
from mirage.commands.builtin.slack.slack_add_reaction import slack_react
from mirage.commands.builtin.slack.slack_get_user_profile import \
    slack_get_user_profile_cmd
from mirage.commands.builtin.slack.slack_get_users import slack_get_users
from mirage.commands.builtin.slack.slack_post_message import slack_post_message
from mirage.commands.builtin.slack.slack_reply_to_thread import slack_reply
from mirage.commands.builtin.slack.slack_search import slack_search
from mirage.core.slack.glob import resolve_glob as _ft_resolve_glob
from mirage.core.slack.read import read as _read
from mirage.core.slack.readdir import is_dir_name as _is_dir_name
from mirage.core.slack.readdir import readdir as _readdir
from mirage.core.slack.stat import stat as _stat
from mirage.core.slack.stream import read_stream as _read_stream

# Messages are read through the generic factory (find walks readdir with the
# is_dir_name hint); grep/rg are bespoke (search-API push-down) and writes go
# through the slack_* commands, so the generic byte-mutation commands are
# absent.
_SLACK_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    is_dir_name=lambda a, name: _is_dir_name(name),
    local=False,
)

COMMANDS = [
    *make_filetype_commands(
        "slack", _ft_resolve_glob, _read, read_takes_index=True),
    *make_generic_commands(
        "slack",
        _SLACK_CMD_OPS,
        overrides={"grep", "rg"},
    ),
    grep,
    rg,
    slack_post_message,
    slack_reply,
    slack_react,
    slack_get_users,
    slack_get_user_profile_cmd,
    slack_search,
]
