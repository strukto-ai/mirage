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

from mirage.commands.builtin.gdocs.basename import basename
from mirage.commands.builtin.gdocs.cat import cat
from mirage.commands.builtin.gdocs.dirname import dirname
from mirage.commands.builtin.gdocs.find import find
from mirage.commands.builtin.gdocs.grep import grep
from mirage.commands.builtin.gdocs.gws_docs_documents_batchUpdate import \
    gws_docs_documents_batchUpdate
from mirage.commands.builtin.gdocs.gws_docs_documents_create import \
    gws_docs_documents_create
from mirage.commands.builtin.gdocs.gws_docs_write import gws_docs_write
from mirage.commands.builtin.gdocs.head import head
from mirage.commands.builtin.gdocs.jq import jq
from mirage.commands.builtin.gdocs.ls import ls
from mirage.commands.builtin.gdocs.nl import nl
from mirage.commands.builtin.gdocs.realpath import realpath
from mirage.commands.builtin.gdocs.rg import rg
from mirage.commands.builtin.gdocs.rm import rm
from mirage.commands.builtin.gdocs.stat import stat
from mirage.commands.builtin.gdocs.tail import tail
from mirage.commands.builtin.gdocs.tree import tree
from mirage.commands.builtin.gdocs.wc import wc

COMMANDS = [
    basename,
    cat,
    dirname,
    find,
    head,
    jq,
    ls,
    nl,
    realpath,
    rg,
    rm,
    stat,
    tail,
    tree,
    wc,
    gws_docs_documents_batchUpdate,
    gws_docs_documents_create,
    gws_docs_write,
    grep,
]
