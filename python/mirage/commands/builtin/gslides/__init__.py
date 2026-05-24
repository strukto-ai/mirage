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

from mirage.commands.builtin.gslides.basename import basename
from mirage.commands.builtin.gslides.cat import cat
from mirage.commands.builtin.gslides.dirname import dirname
from mirage.commands.builtin.gslides.find import find
from mirage.commands.builtin.gslides.grep import grep
from mirage.commands.builtin.gslides.gws_slides_presentations_batchUpdate import \
    gws_slides_presentations_batchUpdate  # noqa: E501
from mirage.commands.builtin.gslides.gws_slides_presentations_create import \
    gws_slides_presentations_create  # noqa: E501
from mirage.commands.builtin.gslides.head import head
from mirage.commands.builtin.gslides.jq import jq
from mirage.commands.builtin.gslides.ls import ls
from mirage.commands.builtin.gslides.nl import nl
from mirage.commands.builtin.gslides.realpath import realpath
from mirage.commands.builtin.gslides.rg import rg
from mirage.commands.builtin.gslides.rm import rm
from mirage.commands.builtin.gslides.stat import stat
from mirage.commands.builtin.gslides.tail import tail
from mirage.commands.builtin.gslides.tree import tree
from mirage.commands.builtin.gslides.wc import wc

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
    gws_slides_presentations_create,
    gws_slides_presentations_batchUpdate,
    grep,
]
