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

from mirage.commands.builtin.generic_bind.provision import \
    with_default_provisions
from mirage.commands.builtin.history.cat import cat
from mirage.commands.builtin.history.find import find
from mirage.commands.builtin.history.grep import grep
from mirage.commands.builtin.history.head import head
from mirage.commands.builtin.history.history import history_cmd
from mirage.commands.builtin.history.ls import ls
from mirage.commands.builtin.history.rg import rg
from mirage.commands.builtin.history.stat import stat
from mirage.commands.builtin.history.tail import tail
from mirage.commands.builtin.history.tree import tree
from mirage.commands.builtin.history.wc import wc
from mirage.core.history.stat import stat as history_stat

# The rendered histfile stats with a real size, so the shared family
# defaults give exact estimates over the view mount.
COMMANDS = with_default_provisions(
    [cat, find, grep, head, history_cmd, ls, rg, stat, tail, tree, wc],
    history_stat)
