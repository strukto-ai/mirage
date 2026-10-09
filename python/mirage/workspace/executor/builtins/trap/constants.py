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

USAGE = "trap: usage: trap [-lp] [[arg] signal_spec ...]\n"

EXIT_EVENT = "EXIT"

# bash's pseudo-signals besides EXIT, ERR and RETURN: names it accepts,
# mirage runs none.
PSEUDO_SIGNALS = frozenset({"DEBUG"})

# The events mirage runs, in the order `trap -p` lists them (bash's
# signal numbers put EXIT (0) first and its pseudo-signals last), each
# with its session fields: the action, and the flag a registration in
# this scope clears.
RUN_EVENTS = {
    TrapEvent.EXIT: ("exit_trap", "exit_trap_inherited"),
    TrapEvent.ERR: ("err_trap", "err_trap_hidden"),
    TrapEvent.RETURN: ("return_trap", "return_trap_hidden"),
}

# The highest signal number bash lists.
SIGNAL_MAX = 64
