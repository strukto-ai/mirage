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

from mirage.commands.builtin.github.awk import awk
from mirage.commands.builtin.github.basename import basename
from mirage.commands.builtin.github.cat import cat
from mirage.commands.builtin.github.cut import cut
from mirage.commands.builtin.github.diff import diff
from mirage.commands.builtin.github.dirname import dirname
from mirage.commands.builtin.github.du import du
from mirage.commands.builtin.github.file import file
from mirage.commands.builtin.github.find import find
from mirage.commands.builtin.github.grep import grep
from mirage.commands.builtin.github.head import head
from mirage.commands.builtin.github.jq import jq
from mirage.commands.builtin.github.ls import ls
from mirage.commands.builtin.github.md5 import md5
from mirage.commands.builtin.github.nl import nl
from mirage.commands.builtin.github.realpath import realpath
from mirage.commands.builtin.github.rg import rg
from mirage.commands.builtin.github.sed import sed
from mirage.commands.builtin.github.sha256sum import sha256sum
from mirage.commands.builtin.github.sort import sort_cmd
from mirage.commands.builtin.github.stat import stat
from mirage.commands.builtin.github.tail import tail
from mirage.commands.builtin.github.tr import tr
from mirage.commands.builtin.github.tree import tree
from mirage.commands.builtin.github.uniq import uniq
from mirage.commands.builtin.github.wc import wc

COMMANDS = [
    awk,
    basename,
    cat,
    cut,
    diff,
    dirname,
    du,
    file,
    find,
    head,
    jq,
    ls,
    md5,
    nl,
    realpath,
    rg,
    sed,
    sha256sum,
    sort_cmd,
    stat,
    tail,
    tr,
    tree,
    uniq,
    wc,
    grep,
]
