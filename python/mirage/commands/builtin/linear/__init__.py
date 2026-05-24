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

from mirage.commands.builtin.linear.basename import basename
from mirage.commands.builtin.linear.cat import cat
from mirage.commands.builtin.linear.dirname import dirname
from mirage.commands.builtin.linear.find import find
from mirage.commands.builtin.linear.grep import grep
from mirage.commands.builtin.linear.head import head
from mirage.commands.builtin.linear.jq import jq
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
from mirage.commands.builtin.linear.ls import ls
from mirage.commands.builtin.linear.realpath import realpath
from mirage.commands.builtin.linear.rg import rg
from mirage.commands.builtin.linear.stat import stat
from mirage.commands.builtin.linear.tail import tail
from mirage.commands.builtin.linear.tree import tree
from mirage.commands.builtin.linear.wc import wc

COMMANDS = [
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
