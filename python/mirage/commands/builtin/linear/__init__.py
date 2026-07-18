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

from mirage.commands.builtin.generic_bind import make_generic_commands
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
from mirage.commands.builtin.linear.ops import OPS as _LINEAR_CMD_OPS

COMMANDS = [
    *make_generic_commands(
        "linear",
        _LINEAR_CMD_OPS,
    ),
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
