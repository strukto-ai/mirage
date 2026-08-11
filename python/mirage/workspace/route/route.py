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

from collections.abc import Iterator

from mirage.workspace.mount import MountRegistry
from mirage.workspace.route.constants import NAMESPACE_COMMANDS, SHELL_NAMES
from mirage.workspace.route.types import Consumer
from mirage.workspace.session import Session


def _layers(name: str, session: Session,
            registry: MountRegistry) -> Iterator[Consumer]:
    """Yield every layer holding the name, most-preferred first.

    The one place precedence is written down: ``route`` reads the first
    yield and ``route_all`` reads all of them. Lazy on purpose, so the
    winner costs exactly what it did before the split (a name an
    installed CLI answers never reaches the mount lookup).

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    if name in SHELL_NAMES:
        yield Consumer.SESSION
    if name in NAMESPACE_COMMANDS:
        yield Consumer.NAMESPACE
    if name in session.functions:
        yield Consumer.FUNCTION
    if registry.clis.get(name) is not None:
        yield Consumer.CLI
    if registry.mount_for_command(name) is not None:
        yield Consumer.MOUNT


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

    This is the winner only. A name can sit in more than one layer at
    once (a function shadowing an installed CLI); ``route_all`` reports
    them all, which is what ``type -a`` prints. Reading one item off the
    generator is what makes that sharing free: the lookups after the
    winner never run, so dispatch pays exactly what it did when this was
    a chain of ``if`` arms.

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    return next(_layers(name, session, registry), Consumer.UNKNOWN)


def route_all(name: str, session: Session,
              registry: MountRegistry) -> list[Consumer]:
    """Every layer holding the name, most-preferred first.

    Empty when nothing holds it, where ``route`` says UNKNOWN. Only
    introspection (``type -a``, ``which -a``) needs this: dispatch runs
    the winner and never asks what it shadowed.

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    return list(_layers(name, session, registry))
