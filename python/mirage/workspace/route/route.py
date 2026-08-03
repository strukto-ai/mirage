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

from mirage.workspace.mount import MountRegistry
from mirage.workspace.route.constants import NAMESPACE_COMMANDS, SHELL_NAMES
from mirage.workspace.route.types import Consumer
from mirage.workspace.session import Session


def route(name: str, session: Session, registry: MountRegistry) -> Consumer:
    """Route a command name to the layer that consumes it.

    Order mirrors dispatch precedence: shell builtins shadow functions,
    functions shadow installed CLIs, CLIs shadow mount commands, and a
    name nobody registers is UNKNOWN (command not found). Install-time
    collision rules keep the CLI arm honest: a CLI may not take a shell
    builtin's or a general command's name, so the only shadowing a CLI
    can actually exert is over a mount-specific custom command.

    The full landscape, in precedence order. The column to watch is
    what resolves the name: session or workspace state for the named
    layers, operand paths for mounts::

        Consumer   Example              Resolved by          Words
        SESSION    cd, echo, export     name in SHELL_NAMES  shell-expanded
        NAMESPACE  ln -s, readlink      NAMESPACE_COMMANDS   shell-expanded
        FUNCTION   deploy() {..}        session.functions    shell-expanded
        CLI        slack message send   registry.clis        shell-expanded
        MOUNT      grep, cat, du        operand paths        pushdown
        UNKNOWN    bogus                nobody               untouched, 127

    Runtimes are orthogonal, not a seventh row: a capture decides where
    a command executes (docker vs vfs), never whether the name exists.

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    if name in SHELL_NAMES:
        return Consumer.SESSION
    if name in NAMESPACE_COMMANDS:
        return Consumer.NAMESPACE
    if name in session.functions:
        return Consumer.FUNCTION
    if registry.clis.get(name) is not None:
        return Consumer.CLI
    if registry.mount_for_command(name) is not None:
        return Consumer.MOUNT
    return Consumer.UNKNOWN
