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

from mirage.commands.builtin.gsheets.basename import basename
from mirage.commands.builtin.gsheets.cat import cat
from mirage.commands.builtin.gsheets.dirname import dirname
from mirage.commands.builtin.gsheets.find import find
from mirage.commands.builtin.gsheets.grep import grep
from mirage.commands.builtin.gsheets.gws_sheets_append import gws_sheets_append
from mirage.commands.builtin.gsheets.gws_sheets_read import gws_sheets_read
from mirage.commands.builtin.gsheets.gws_sheets_spreadsheets_batchUpdate import \
    gws_sheets_spreadsheets_batchUpdate  # noqa: E501
from mirage.commands.builtin.gsheets.gws_sheets_spreadsheets_create import \
    gws_sheets_spreadsheets_create  # noqa: E501
from mirage.commands.builtin.gsheets.gws_sheets_write import gws_sheets_write
from mirage.commands.builtin.gsheets.head import head
from mirage.commands.builtin.gsheets.jq import jq
from mirage.commands.builtin.gsheets.ls import ls
from mirage.commands.builtin.gsheets.nl import nl
from mirage.commands.builtin.gsheets.realpath import realpath
from mirage.commands.builtin.gsheets.rg import rg
from mirage.commands.builtin.gsheets.rm import rm
from mirage.commands.builtin.gsheets.stat import stat
from mirage.commands.builtin.gsheets.tail import tail
from mirage.commands.builtin.gsheets.tree import tree
from mirage.commands.builtin.gsheets.wc import wc

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
    gws_sheets_append,
    gws_sheets_read,
    gws_sheets_spreadsheets_batchUpdate,
    gws_sheets_spreadsheets_create,
    gws_sheets_write,
    grep,
]
