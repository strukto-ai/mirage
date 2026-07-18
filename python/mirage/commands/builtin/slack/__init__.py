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
from mirage.commands.builtin.generic_bind import make_generic_commands
from mirage.commands.builtin.slack.grep import grep
from mirage.commands.builtin.slack.io import IO as _IO
from mirage.commands.builtin.slack.rg import rg
from mirage.commands.builtin.slack.slack_add_reaction import slack_react
from mirage.commands.builtin.slack.slack_get_user_profile import \
    slack_get_user_profile_cmd
from mirage.commands.builtin.slack.slack_get_users import slack_get_users
from mirage.commands.builtin.slack.slack_post_message import slack_post_message
from mirage.commands.builtin.slack.slack_reply_to_thread import slack_reply
from mirage.commands.builtin.slack.slack_search import slack_search
from mirage.core.slack.read import read as _read

COMMANDS = [
    *make_filetype_commands(
        "slack", _IO.resolve_glob, _read, read_takes_index=True),
    *make_generic_commands(
        "slack",
        _IO,
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
