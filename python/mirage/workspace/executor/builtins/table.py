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

from mirage.shell.types import ShellBuiltin as SB
from mirage.workspace.executor.builtins.alias.alias import (
    alias_builtin,
    unalias_builtin,
)
from mirage.workspace.executor.builtins.command.command import command_builtin
from mirage.workspace.executor.builtins.condition.condition import test_builtin
from mirage.workspace.executor.builtins.control.control import (
    break_builtin,
    colon_builtin,
    continue_builtin,
    exit_builtin,
    false_builtin,
    return_builtin,
    true_builtin,
)
from mirage.workspace.executor.builtins.declare.export import export_builtin
from mirage.workspace.executor.builtins.declare.local import local_builtin
from mirage.workspace.executor.builtins.dirs.cd import cd_builtin
from mirage.workspace.executor.builtins.dirs.pwd import pwd_builtin
from mirage.workspace.executor.builtins.echo.echo import echo_builtin
from mirage.workspace.executor.builtins.env.env import env_builtin
from mirage.workspace.executor.builtins.eval.eval import eval_builtin
from mirage.workspace.executor.builtins.exec.exec import exec_builtin
from mirage.workspace.executor.builtins.getopts.getopts import getopts_builtin
from mirage.workspace.executor.builtins.help.help import help_builtin
from mirage.workspace.executor.builtins.history.history import history_builtin
from mirage.workspace.executor.builtins.let.let import let_builtin
from mirage.workspace.executor.builtins.lookup.lookup import (
    type_builtin,
    which_builtin,
)
from mirage.workspace.executor.builtins.man.man import man_builtin
from mirage.workspace.executor.builtins.mapfile.mapfile import mapfile_builtin
from mirage.workspace.executor.builtins.printenv.printenv import (
    printenv_builtin,
)
from mirage.workspace.executor.builtins.printf.printf import printf_builtin
from mirage.workspace.executor.builtins.read.read import read_builtin
from mirage.workspace.executor.builtins.script.bash import bash_builtin
from mirage.workspace.executor.builtins.script.source import source_builtin
from mirage.workspace.executor.builtins.set.set import set_builtin
from mirage.workspace.executor.builtins.shift.shift import shift_builtin
from mirage.workspace.executor.builtins.shopt.shopt import shopt_builtin
from mirage.workspace.executor.builtins.sleep.sleep import sleep_builtin
from mirage.workspace.executor.builtins.timeout.timeout import timeout_builtin
from mirage.workspace.executor.builtins.trap.trap import trap_builtin
from mirage.workspace.executor.builtins.types import BuiltinFn
from mirage.workspace.executor.builtins.umask.umask import umask_builtin
from mirage.workspace.executor.builtins.unset.unset import unset_builtin
from mirage.workspace.executor.builtins.whoami.whoami import whoami_builtin
from mirage.workspace.executor.builtins.xargs.xargs import xargs_builtin

# The one map from an executor-run builtin word to its handler; the
# dispatcher does a single lookup here instead of one arm per word. Two
# ShellBuiltin groups are deliberately absent: the job builtins (wait,
# fg, kill, jobs, disown, ps) route through JOB_HANDLERS in
# executor/command/command.py because they need the job table, and
# python/python3/node/js are general mount commands
# (commands/builtin/general), reserved in ShellBuiltin only so no CLI
# can take the name. tests/workspace/executor/builtins/test_table.py
# pins that everything else is here.
BUILTINS: dict[str, BuiltinFn] = {
    SB.PWD: pwd_builtin,
    SB.CD: cd_builtin,
    SB.EXPORT: export_builtin,
    SB.UNSET: unset_builtin,
    SB.LOCAL: local_builtin,
    SB.SET: set_builtin,
    SB.READ: read_builtin,
    SB.MAPFILE: mapfile_builtin,
    SB.READARRAY: mapfile_builtin,
    SB.SHIFT: shift_builtin,
    SB.GETOPTS: getopts_builtin,
    SB.LET: let_builtin,
    SB.TRAP: trap_builtin,
    SB.SHOPT: shopt_builtin,
    SB.UMASK: umask_builtin,
    SB.ALIAS: alias_builtin,
    SB.UNALIAS: unalias_builtin,
    SB.EXEC: exec_builtin,
    SB.TEST: test_builtin,
    SB.BRACKET: test_builtin,
    SB.DOUBLE_BRACKET: test_builtin,
    SB.ECHO: echo_builtin,
    SB.PRINTF: printf_builtin,
    SB.SOURCE: source_builtin,
    SB.DOT: source_builtin,
    SB.EVAL: eval_builtin,
    SB.COMMAND: command_builtin,
    SB.TYPE: type_builtin,
    SB.WHICH: which_builtin,
    SB.HELP: help_builtin,
    SB.TRUE: true_builtin,
    SB.FALSE: false_builtin,
    SB.COLON: colon_builtin,
    SB.BREAK: break_builtin,
    SB.CONTINUE: continue_builtin,
    SB.RETURN: return_builtin,
    SB.EXIT: exit_builtin,
    SB.PRINTENV: printenv_builtin,
    SB.ENV: env_builtin,
    SB.WHOAMI: whoami_builtin,
    SB.MAN: man_builtin,
    SB.HISTORY: history_builtin,
    SB.SLEEP: sleep_builtin,
    SB.BASH: bash_builtin,
    SB.SH: bash_builtin,
    SB.XARGS: xargs_builtin,
    SB.TIMEOUT: timeout_builtin,
}
