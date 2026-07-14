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

from mirage.workspace.executor.builtins.condition import handle_test
from mirage.workspace.executor.builtins.dirs import handle_cd
from mirage.workspace.executor.builtins.history import handle_history
from mirage.workspace.executor.builtins.links import (follow_paths, handle_ln,
                                                      handle_readlink,
                                                      link_flags, prepare_mv,
                                                      strip_link_operands)
from mirage.workspace.executor.builtins.man import (_collect_man_hits,
                                                    _render_man_entry,
                                                    _render_man_index,
                                                    handle_man)
from mirage.workspace.executor.builtins.metadata import (handle_chmod,
                                                         handle_chown,
                                                         handle_touch)
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.executor.builtins.script import (handle_bash,
                                                       handle_eval,
                                                       handle_sleep,
                                                       handle_source)
from mirage.workspace.executor.builtins.text import (_interpret_escapes,
                                                     handle_echo,
                                                     handle_printf)
from mirage.workspace.executor.builtins.timeout import handle_timeout
from mirage.workspace.executor.builtins.xargs import handle_xargs

from mirage.workspace.executor.builtins.vars import (  # isort: skip
    handle_export, handle_local, handle_printenv, handle_read, handle_readonly,
    handle_return, handle_set, handle_shift, handle_trap, handle_unset,
    handle_whoami)

__all__ = [
    '_collect_man_hits',
    '_interpret_escapes',
    '_render_man_entry',
    '_render_man_index',
    '_scope_path',
    '_to_scope',
    'handle_bash',
    'handle_cd',
    'handle_echo',
    'handle_eval',
    'handle_export',
    'handle_history',
    'handle_ln',
    'handle_local',
    'handle_readlink',
    'link_flags',
    'follow_paths',
    'handle_chmod',
    'handle_chown',
    'handle_touch',
    'prepare_mv',
    'strip_link_operands',
    'handle_man',
    'handle_printenv',
    'handle_printf',
    'handle_read',
    'handle_readonly',
    'handle_return',
    'handle_set',
    'handle_shift',
    'handle_sleep',
    'handle_source',
    'handle_test',
    'handle_timeout',
    'handle_trap',
    'handle_unset',
    'handle_whoami',
    'handle_xargs',
]
