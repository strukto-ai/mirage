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

from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.linear.find import find
from mirage.commands.builtin.linear.linear_issue_add_label import \
    linear_issue_add_label
from mirage.commands.builtin.linear.linear_issue_assign import \
    linear_issue_assign
from mirage.commands.builtin.linear.linear_issue_comment_add import \
    linear_issue_comment_add
from mirage.commands.builtin.linear.linear_issue_comment_update import \
    linear_issue_comment_update
from mirage.commands.builtin.linear.linear_issue_create import \
    linear_issue_create
from mirage.commands.builtin.linear.linear_issue_set_priority import \
    linear_issue_set_priority
from mirage.commands.builtin.linear.linear_issue_set_project import \
    linear_issue_set_project
from mirage.commands.builtin.linear.linear_issue_transition import \
    linear_issue_transition
from mirage.commands.builtin.linear.linear_issue_update import \
    linear_issue_update
from mirage.commands.builtin.linear.linear_search import linear_search
from mirage.core.linear.read import read as _read
from mirage.core.linear.readdir import readdir as _readdir
from mirage.core.linear.stat import stat as _stat
from mirage.core.linear.stream import read_stream as _read_stream

# Linear issues/projects/teams are read through the generic factory; find keeps
# a wrapper for its bespoke readdir-walk filtering, and the linear_issue_* and
# linear_search commands are the bespoke write/search surface. The generic
# byte-mutation commands are intentionally absent (mutations go through the
# platform commands, no write op wired).
_LINEAR_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
)

_LINEAR_OVERRIDES = {"find"}

COMMANDS = [
    *make_generic_commands(
        "linear",
        _LINEAR_CMD_OPS,
        overrides=_LINEAR_OVERRIDES,
    ),
    find,
    linear_issue_add_label,
    linear_issue_assign,
    linear_issue_comment_add,
    linear_issue_comment_update,
    linear_issue_create,
    linear_issue_set_priority,
    linear_issue_set_project,
    linear_issue_transition,
    linear_issue_update,
    linear_search,
]
