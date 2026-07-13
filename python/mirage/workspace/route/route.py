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
    functions shadow mount commands, and a name nobody registers is
    UNKNOWN (command not found).

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
    if registry.mount_for_command(name) is not None:
        return Consumer.MOUNT
    return Consumer.UNKNOWN
