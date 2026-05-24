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

from mirage.commands.builtin.paperclip.basename import basename
from mirage.commands.builtin.paperclip.cat import cat
from mirage.commands.builtin.paperclip.dirname import dirname
from mirage.commands.builtin.paperclip.find import find
from mirage.commands.builtin.paperclip.grep import grep
from mirage.commands.builtin.paperclip.head import head
from mirage.commands.builtin.paperclip.jq import jq
from mirage.commands.builtin.paperclip.lookup import lookup
from mirage.commands.builtin.paperclip.ls import ls
from mirage.commands.builtin.paperclip.map import map_cmd
from mirage.commands.builtin.paperclip.realpath import realpath
from mirage.commands.builtin.paperclip.rg import rg
from mirage.commands.builtin.paperclip.scan import scan
from mirage.commands.builtin.paperclip.search import search
from mirage.commands.builtin.paperclip.stat import stat
from mirage.commands.builtin.paperclip.tail import tail
from mirage.commands.builtin.paperclip.tree import tree
from mirage.commands.builtin.paperclip.wc import wc

COMMANDS = [
    basename,
    cat,
    dirname,
    find,
    grep,
    head,
    jq,
    lookup,
    ls,
    map_cmd,
    realpath,
    rg,
    scan,
    search,
    stat,
    tail,
    tree,
    wc,
]
