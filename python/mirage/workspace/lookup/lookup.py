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

from collections.abc import Iterator, Sequence

from mirage.policy.match import head_visible, node_visible
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.routing.types import RouteDecision
from mirage.workspace.lookup.constants import (INTERPRETER_NAMES,
                                               NAMESPACE_COMMANDS, SHELL_NAMES)
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session


def listed(name: str, session: Session) -> bool:
    """What the session's allow list says about a tool word.

    A profile without a list installs everything; a profile with one installs
    only the names its patterns start with (``head_visible``). This is
    the raw answer; ``command_visible`` and ``_layers`` add the words
    that are never subjects.

    Args:
        name (str): expanded command name.
        session (Session): the shell session running the line.
    """
    return head_visible(name, session.commands)


def is_tool(name: str, session: Session) -> bool:
    """Whether a command word is a tool the allow lists govern.

    Every named command is a subject, shell builtins included: an allow
    list stating ``cat`` leaves no ``echo`` and no ``cd``. Two kinds of
    word are not, because neither is a name the list could hold: a path
    being executed (its lines are each checked as they run), and the
    agent's own function where the function is what runs, which in this
    shell means a name no builtin owns (builtins shadow functions), so
    a function cannot resurrect a hidden builtin, and its body's lines
    each pass this gate themselves.

    Args:
        name (str): expanded command name.
        session (Session): the shell session running the line.
    """
    if "/" in name:
        return False
    return not (name in session.functions and name not in SHELL_NAMES)


def command_visible(name: str, session: Session) -> bool:
    """Whether a session can see a command word at all.

    The profile's allow list (``commands.allow``) decides: a tool name no
    pattern of it starts with is not installed for the session, so it
    is 127 at the chokepoint and absent from every enumerator; a word
    that is not a tool (``is_tool``) is always visible.

    Args:
        name (str): expanded command name.
        session (Session): the shell session running the line.
    """
    return not is_tool(name, session) or listed(name, session)


def verb_visible(head: str, path: Sequence[str], session: Session) -> bool:
    """Whether a session can see one node of an installed CLI's tree.

    ``command_visible`` answers for a word, which is all dispatch needs:
    a CLI is routed by its head word and the verbs after it are the
    program's own operand. Discovery needs the finer answer, because a
    profile allowed ``linear issue list`` is not allowed ``linear team``,
    and a manual that lists the second is advertising a line that
    cannot run. ``is_tool``'s exemptions have nothing to say here:
    shell grammar and functions are single words, so a verb path only
    ever belongs to a CLI whose head word already passed.

    Args:
        head (str): the installed head word, as typed.
        path (Sequence[str]): canonical verb words after the head,
            empty for the root.
        session (Session): the shell session running the line.
    """
    return node_visible((head, *path), session.commands)


def runtime_refused(name: str,
                    session: Session,
                    registry: MountRegistry,
                    routing: RouteDecision | None = None) -> bool:
    """Whether routing explicitly refused the external runtime for ``name``."""
    if routing is None:
        return False
    bindings = routing.bindings
    key = name if name in bindings else EXTERNAL_COMMANDS
    return (key in bindings and bindings[key] is None
            and lookup(name, session, registry) is Consumer.EXTERNAL)


def _layers(name: str,
            session: Session,
            registry: MountRegistry,
            routing: RouteDecision | None = None) -> Iterator[Consumer]:
    """Yield every layer holding the name, most-preferred first.

    The one place precedence is written down: ``lookup`` reads the first
    yield and ``lookup_all`` reads all of them. Lazy on purpose, so the
    winner costs exactly what it did before the split (a name an
    installed CLI answers never reaches the mount lookup). The
    document's visibility filter lives here too, so ``type``, ``which``,
    ``command -v`` and dispatch agree on what a session can see: an
    unlisted word yields nothing, builtins included (only functions are
    not subjects, and a function named after a hidden builtin is as
    unreachable as the builtin).

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    installed = listed(name, session)
    found = False
    bindings = (routing.bindings
                if routing is not None else registry.runtime_bindings)
    bound = (bindings[name]
             if name in bindings else registry.runtime_bindings.get(name))
    native = isinstance(bound, (LineExecutorMixin, ProcessExecutorMixin))
    refused = runtime_refused(name, session, registry, routing)
    if name in SHELL_NAMES and installed:
        found = True
        yield (Consumer.EXTERNAL if (native or refused)
               and name in INTERPRETER_NAMES else Consumer.SESSION)
    if installed and name in NAMESPACE_COMMANDS:
        found = True
        yield Consumer.NAMESPACE
    if name in session.functions and (installed or name not in SHELL_NAMES):
        found = True
        yield Consumer.FUNCTION
    if installed and registry.clis.get(name) is not None:
        found = True
        yield Consumer.CLI
    if installed and (native or refused) and name not in SHELL_NAMES:
        found = True
        yield Consumer.EXTERNAL
    if installed and registry.mount_for_command(name) is not None:
        found = True
        yield Consumer.MOUNT
    fallback = (bindings[EXTERNAL_COMMANDS] if EXTERNAL_COMMANDS in bindings
                else registry.runtime_bindings.get(EXTERNAL_COMMANDS))
    fallback_native = isinstance(fallback,
                                 (LineExecutorMixin, ProcessExecutorMixin))
    if (installed and not found and name not in bindings
            and name not in registry.runtime_unavailable
            and (fallback_native or refused)):
        yield Consumer.EXTERNAL


def lookup(name: str,
           session: Session,
           registry: MountRegistry,
           routing: RouteDecision | None = None) -> Consumer:
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

    Named process captures select EXTERNAL before mount commands. The
    EXTERNAL_COMMANDS capture handles names no preceding layer owns.

    This is the winner only. A name can sit in more than one layer at
    once (a function shadowing an installed CLI); ``lookup_all`` reports
    them all, which is what ``type -a`` prints. Reading one item off the
    generator is what makes that sharing free: the lookups after the
    winner never run, so dispatch pays exactly what it did when this was
    a chain of ``if`` arms.

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    return next(_layers(name, session, registry, routing), Consumer.UNKNOWN)


def lookup_all(name: str, session: Session,
               registry: MountRegistry) -> list[Consumer]:
    """Every layer holding the name, most-preferred first.

    Empty when nothing holds it, where ``lookup`` says UNKNOWN. Only
    introspection (``type -a``, ``which -a``) needs this: dispatch runs
    the winner and never asks what it shadowed.

    Args:
        name (str): expanded command name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry (command registration).
    """
    return list(_layers(name, session, registry))
