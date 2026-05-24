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

from mirage.commands.builtin.telegram.basename import basename
from mirage.commands.builtin.telegram.cat import cat
from mirage.commands.builtin.telegram.dirname import dirname
from mirage.commands.builtin.telegram.find import find
from mirage.commands.builtin.telegram.grep import grep
from mirage.commands.builtin.telegram.head import head
from mirage.commands.builtin.telegram.jq import jq
from mirage.commands.builtin.telegram.ls import ls
from mirage.commands.builtin.telegram.realpath import realpath
from mirage.commands.builtin.telegram.rg import rg
from mirage.commands.builtin.telegram.stat import stat
from mirage.commands.builtin.telegram.tail import tail
from mirage.commands.builtin.telegram.telegram_send_message import \
    telegram_send_message
from mirage.commands.builtin.telegram.tree import tree
from mirage.commands.builtin.telegram.wc import wc

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
    telegram_send_message,
]
