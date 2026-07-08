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

from enum import Enum, auto

from mirage.shell.types import ShellBuiltin
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session

# Bash builtins the parser accepts but the executor cannot honor; they
# still route to the shell layer so the error names a capability gap.
UNSUPPORTED_BUILTINS = frozenset({
    "bg",
    "disown",
    "exec",
    "complete",
    "compgen",
    "ulimit",
})

NAMESPACE_COMMANDS = frozenset({"ln", "readlink"})

_SHELL_NAMES = frozenset(str(b) for b in ShellBuiltin) | UNSUPPORTED_BUILTINS


class Consumer(Enum):
    """The layer that consumes a command: a command belongs to the layer
    whose state it mutates.

    The verdict drives both the dispatch branch and the word policy:
    SESSION / NAMESPACE / FUNCTION words are shell-resolved (bash
    contract: programs receive matches, never patterns); MOUNT words
    keep glob patterns intact for backend pushdown; UNKNOWN words are
    never resolved (the command fails, backend I/O for it is waste).
    """

    SESSION = auto()
    NAMESPACE = auto()
    FUNCTION = auto()
    MOUNT = auto()
    UNKNOWN = auto()


SHELL_CONSUMERS = frozenset({
    Consumer.SESSION,
    Consumer.NAMESPACE,
    Consumer.FUNCTION,
})


def route(name: str, session: Session, registry: MountRegistry) -> Consumer:
    """Route a command name to the layer that consumes it.

    Order mirrors dispatch precedence: shell builtins shadow functions,
    functions shadow mount commands, and a name nobody registers is
    UNKNOWN (command not found).

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    if name in _SHELL_NAMES:
        return Consumer.SESSION
    if name in NAMESPACE_COMMANDS:
        return Consumer.NAMESPACE
    if name in session.functions:
        return Consumer.FUNCTION
    if registry.mount_for_command(name) is not None:
        return Consumer.MOUNT
    return Consumer.UNKNOWN
