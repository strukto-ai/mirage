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

from mirage.commands.builtin.general.bc import bc
from mirage.commands.builtin.general.curl import curl
from mirage.commands.builtin.general.date import date
from mirage.commands.builtin.general.expr import expr
from mirage.commands.builtin.general.history import history_cmd
from mirage.commands.builtin.general.python import python3, python_cmd
from mirage.commands.builtin.general.seq import seq
from mirage.commands.builtin.general.wget import wget

_FNS = [bc, curl, date, expr, python3, python_cmd, seq, wget]
HISTORY_FN = history_cmd
HISTORY_COMMANDS = list(history_cmd._registered_commands)

COMMANDS = []
for _fn in _FNS:
    COMMANDS.extend(_fn._registered_commands)
