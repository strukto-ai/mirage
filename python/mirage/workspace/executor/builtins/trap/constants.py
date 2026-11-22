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

from mirage.workspace.executor.builtins.trap.types import TrapEvent

# The events mirage runs besides signals, each with its session fields:
# the action, and the flag a registration in this scope clears. `trap -p`
# lists EXIT (signal 0) first, then the signals by number, then ERR and
# RETURN.
RUN_EVENTS = {
    TrapEvent.EXIT: ("exit_trap", "exit_trap_inherited"),
    TrapEvent.ERR: ("err_trap", "err_trap_hidden"),
    TrapEvent.RETURN: ("return_trap", "return_trap_hidden"),
}

# The highest signal number bash lists.
SIGNAL_MAX = 64
