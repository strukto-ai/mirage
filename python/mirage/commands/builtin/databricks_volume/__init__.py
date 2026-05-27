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

from mirage.commands.builtin.databricks_volume.awk import awk
from mirage.commands.builtin.databricks_volume.cat import cat
from mirage.commands.builtin.databricks_volume.cut import cut
from mirage.commands.builtin.databricks_volume.diff import diff
from mirage.commands.builtin.databricks_volume.find import find
from mirage.commands.builtin.databricks_volume.grep import grep
from mirage.commands.builtin.databricks_volume.head import head
from mirage.commands.builtin.databricks_volume.jq import jq
from mirage.commands.builtin.databricks_volume.ls import ls
from mirage.commands.builtin.databricks_volume.nl import nl
from mirage.commands.builtin.databricks_volume.rg import rg
from mirage.commands.builtin.databricks_volume.rm import rm
from mirage.commands.builtin.databricks_volume.sed import sed
from mirage.commands.builtin.databricks_volume.sort import sort
from mirage.commands.builtin.databricks_volume.stat import stat
from mirage.commands.builtin.databricks_volume.tail import tail
from mirage.commands.builtin.databricks_volume.touch import touch
from mirage.commands.builtin.databricks_volume.tr import tr
from mirage.commands.builtin.databricks_volume.tree import tree
from mirage.commands.builtin.databricks_volume.uniq import uniq
from mirage.commands.builtin.databricks_volume.wc import wc

COMMANDS = [
    awk,
    cat,
    cut,
    diff,
    find,
    grep,
    head,
    jq,
    ls,
    nl,
    rm,
    rg,
    sed,
    sort,
    stat,
    tail,
    touch,
    tree,
    tr,
    uniq,
    wc,
]
