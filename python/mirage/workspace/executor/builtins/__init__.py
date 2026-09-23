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

from mirage.workspace.executor.builtins.alias import (handle_alias,
                                                      handle_unalias)
from mirage.workspace.executor.builtins.command import handle_command_builtin
from mirage.workspace.executor.builtins.condition import handle_test
from mirage.workspace.executor.builtins.df import handle_df
from mirage.workspace.executor.builtins.dirs import handle_cd
from mirage.workspace.executor.builtins.echo import (handle_echo,
                                                     interpret_escapes)
from mirage.workspace.executor.builtins.env import handle_env
from mirage.workspace.executor.builtins.eval import handle_eval
from mirage.workspace.executor.builtins.exec import handle_exec_command
from mirage.workspace.executor.builtins.getopts import handle_getopts
from mirage.workspace.executor.builtins.history import handle_history
from mirage.workspace.executor.builtins.let import handle_let
from mirage.workspace.executor.builtins.links import (accepts_line,
                                                      follow_paths, handle_ln,
                                                      handle_readlink,
                                                      link_flags, prepare_mv,
                                                      strip_link_operands)
from mirage.workspace.executor.builtins.lookup import handle_type, handle_which
from mirage.workspace.executor.builtins.man import (_command_entry,
                                                    _render_man_index,
                                                    _render_page, handle_man)
from mirage.workspace.executor.builtins.mapfile import handle_mapfile
from mirage.workspace.executor.builtins.metadata import (handle_chgrp,
                                                         handle_chmod,
                                                         handle_chown,
                                                         handle_touch)
from mirage.workspace.executor.builtins.metadata.getfattr import \
    handle_getfattr
from mirage.workspace.executor.builtins.metadata.setfattr import \
    handle_setfattr
from mirage.workspace.executor.builtins.printenv import handle_printenv
from mirage.workspace.executor.builtins.printf import handle_printf
from mirage.workspace.executor.builtins.read import handle_read
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.executor.builtins.script import (handle_bash,
                                                       handle_exec_path,
                                                       handle_source)
from mirage.workspace.executor.builtins.set import handle_set
from mirage.workspace.executor.builtins.shift import handle_shift
from mirage.workspace.executor.builtins.shopt import handle_shopt
from mirage.workspace.executor.builtins.sleep import handle_sleep
from mirage.workspace.executor.builtins.timeout import handle_timeout
from mirage.workspace.executor.builtins.trap import handle_trap
from mirage.workspace.executor.builtins.umask import handle_umask
from mirage.workspace.executor.builtins.unset import handle_unset
from mirage.workspace.executor.builtins.whoami import handle_whoami
from mirage.workspace.executor.builtins.xargs import handle_xargs

from mirage.workspace.executor.builtins.control import (  # isort: skip
    handle_colon, handle_exit, handle_false, handle_return, handle_true,
    loop_levels)

from mirage.workspace.executor.builtins.declare import (  # isort: skip
    handle_declare_functions, handle_declare_print, handle_export,
    handle_local, handle_readonly, note_local_array)

__all__ = [
    '_command_entry',
    'handle_alias',
    'handle_unalias',
    '_render_man_index',
    '_render_page',
    '_scope_path',
    '_to_scope',
    'handle_bash',
    'handle_cd',
    'handle_colon',
    'handle_command_builtin',
    'handle_echo',
    'handle_env',
    'handle_eval',
    'handle_exit',
    'handle_false',
    'handle_exec_command',
    'handle_declare_functions',
    'handle_declare_print',
    'handle_export',
    'handle_history',
    'handle_let',
    'handle_ln',
    'handle_local',
    'handle_readlink',
    'link_flags',
    'accepts_line',
    'follow_paths',
    'handle_df',
    'handle_chgrp',
    'handle_chmod',
    'handle_chown',
    'handle_getfattr',
    'handle_setfattr',
    'handle_touch',
    'prepare_mv',
    'strip_link_operands',
    'handle_man',
    'handle_mapfile',
    'handle_printenv',
    'handle_printf',
    'handle_read',
    'handle_readonly',
    'handle_return',
    'handle_getopts',
    'handle_set',
    'handle_shift',
    'handle_shopt',
    'handle_sleep',
    'handle_exec_path',
    'handle_source',
    'handle_test',
    'handle_timeout',
    'handle_trap',
    'handle_true',
    'handle_unset',
    'handle_type',
    'handle_umask',
    'handle_which',
    'handle_whoami',
    'note_local_array',
    'handle_xargs',
    'interpret_escapes',
    'loop_levels',
]
