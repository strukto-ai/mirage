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

from mirage.commands.builtin.notion.basename import basename
from mirage.commands.builtin.notion.cat import cat
from mirage.commands.builtin.notion.dirname import dirname
from mirage.commands.builtin.notion.find import find
from mirage.commands.builtin.notion.grep import grep
from mirage.commands.builtin.notion.head import head
from mirage.commands.builtin.notion.jq import jq
from mirage.commands.builtin.notion.ls import ls
from mirage.commands.builtin.notion.notion_block_append import \
    notion_block_append
from mirage.commands.builtin.notion.notion_comment_add import \
    notion_comment_add
from mirage.commands.builtin.notion.notion_page_create import \
    notion_page_create
from mirage.commands.builtin.notion.notion_search import notion_search
from mirage.commands.builtin.notion.realpath import realpath
from mirage.commands.builtin.notion.rg import rg
from mirage.commands.builtin.notion.stat import stat
from mirage.commands.builtin.notion.tail import tail
from mirage.commands.builtin.notion.tree import tree

COMMANDS = [
    basename,
    cat,
    dirname,
    find,
    head,
    jq,
    ls,
    notion_block_append,
    notion_comment_add,
    notion_page_create,
    notion_search,
    realpath,
    rg,
    stat,
    tail,
    tree,
    grep,
]
