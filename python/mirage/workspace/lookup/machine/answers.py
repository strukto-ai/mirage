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

import asyncio
import logging
from collections.abc import Sequence

from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.shell.bytes import decode_text
from mirage.shell.constants import BIN_PREFIX
from mirage.shell.join import shell_join
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError, resolve_path
from mirage.utils.quote import shell_quote
from mirage.vfs.bin import BinViewVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.lookup.constants import KEYWORDS
from mirage.workspace.lookup.lookup import lookup_all
from mirage.workspace.lookup.machine.mounts import machine_holding_all
from mirage.workspace.lookup.machine.search import searched_machine
from mirage.workspace.lookup.types import (
    Consumer,
    MachineAnswer,
    ProgramLookup,
)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot

logger = logging.getLogger(__name__)


def lookup_machine(
    name: str,
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    past_functions: bool,
) -> RemoteRuntime | None:
    """The machine a lookup of ``name`` asks: the one that would run it
    as a program on this line; None when Mirage answers for it, or no
    machine would run it.

    Mirage answers a name it holds in any layer: a builtin, a namespace
    command, a CLI, a mount command, and a function unless the lookup
    looks past functions to the file a run would exec (``which``,
    ``type -P``, ``type -a``). Any other name is the machine's that
    takes it by name, else the one taking ``@external``, as the line's
    placement binds them (``ProgramLookup`` has the whole rule), unless
    that machine refuses the session's runs (``refuses_session``).

    Args:
        name (str): the name looked up.
        session (SessionState): the session it is looked up in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement; None for
            the workspace's own bindings.
        past_functions (bool): the lookup finds the program a function
            of the same name shadows.
    """
    if "/" in name or name in KEYWORDS:
        return None
    for consumer in lookup_all(name, session, registry, routing):
        if consumer is Consumer.FUNCTION and past_functions:
            continue
        if consumer is not Consumer.EXTERNAL:
            return None
    bindings = (
        routing.bindings if routing is not None else registry.runtime_bindings
    )
    runtime = (
        bindings[name] if name in bindings else bindings.get(EXTERNAL_COMMANDS)
    )
    if not isinstance(runtime, RemoteRuntime) or runtime.refuses_session():
        return None
    return runtime


def bin_program(
    path: str,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    routing: RouteDecision[RuntimeIdentity] | None,
) -> str | None:
    """The program a ``/usr/bin/NAME`` path runs by name, for a path no
    file of Mirage's or of a machine Mirage shows is at: NAME, where a
    machine runs it on this line (``lookup_machine``), since a lookup
    prints that path for a program whose own file Mirage does not show;
    None for any other path.

    Args:
        path (str): the head word, as typed.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        routing (RouteDecision | None): the line's placement.
    """
    try:
        target = links.follow(resolve_path(path, session.cwd))
    except CycleError:
        logger.debug("%s: a link loop names no program", path, exc_info=True)
        return None
    entry = registry.try_mount_for(target)
    if entry is None or not isinstance(entry.vfs, BinViewVFS):
        return None
    name = mount_key(target, entry.prefix).strip("/")
    if not name or "/" in name:
        return None
    if lookup_machine(name, session, registry, routing, True) is None:
        return None
    return name


def _lookup_line(command: str, letters: str, name: str) -> str:
    """The line a machine runs for a lookup: the command the agent typed,
    on this one name, after ``--`` where it starts with a dash, so the
    machine reads it as the name it is. ``type`` and ``command`` are
    bash's builtins, so they run in the machine's bash, its ``sh`` where
    it has none; dash's ``type`` takes no options, so there it gets the
    name bare.

    Args:
        command (str): ``which``, ``type`` or ``command``.
        letters (str): the options the agent gave it.
        name (str): the name looked up.
    """
    words = [command, *([f"-{letters}"] if letters else [])]
    line = shell_join(
        [*words, *(["--"] if name.startswith("-") else []), name]
    )
    if command == "which":
        return line
    plain = shell_join([*words, name]) if command == "type" else line
    return (
        f"if [ -x /bin/bash ]; then exec /bin/bash -c {shell_quote(line)}; "
        f"fi; exec /bin/sh -c {shell_quote(plain)}"
    )


def _path_in(line: str, name: str, kind: ProgramLookup) -> str | None:
    """The path a line of a machine's answer names, None for none: a
    PATH answer is the path, a KIND one names it after ``NAME is``.

    Args:
        line (str): one line of the answer.
        name (str): the name looked up.
        kind (ProgramLookup): what the lookup asks.
    """
    if kind is ProgramLookup.PATH:
        return line if line.startswith("/") else None
    lead = f"{name} is "
    if kind is ProgramLookup.KIND and line.startswith(lead + "/"):
        return line[len(lead) :]
    return None


async def _answer(
    command: str,
    letters: str,
    name: str,
    kind: ProgramLookup,
    runtime: RemoteRuntime,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> MachineAnswer:
    """What ``runtime``'s machine answers the lookup of one name, in the
    environment a program run there gets, each path it prints kept only
    where Mirage shows that same path as the machine's own file, the
    name's ``/usr/bin`` file otherwise.

    Args:
        command (str): ``which``, ``type`` or ``command``.
        letters (str): the options the agent gave it.
        name (str): the name looked up.
        kind (ProgramLookup): what the lookup asks.
        runtime (RemoteRuntime): the machine that runs the name.
        session (SessionState): the session it is looked up in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    done = await runtime.handle().look_up(
        _lookup_line(command, letters, name), env_snapshot(session)
    )
    lines: list[str] = []
    for line in decode_text(done.stdout).splitlines():
        path = _path_in(line, name, kind)
        if path is not None:
            held = await machine_holding_all(
                [(path, False)], session, registry, links, None
            )
            if held is None or held.default_machine != runtime.default_machine:
                line = line[: len(line) - len(path)] + f"{BIN_PREFIX}/{name}"
        if line not in lines:
            lines.append(line)
    return MachineAnswer(done.exit_code == 0, tuple(lines))


async def machine_answers(
    command: str,
    letters: str,
    names: Sequence[str],
    kind: ProgramLookup,
    past_functions: bool,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    routing: RouteDecision[RuntimeIdentity] | None,
) -> dict[str, MachineAnswer]:
    """What the machine that runs each name answered the lookup the agent
    typed, for each name a machine runs (``lookup_machine``); a name
    Mirage answers for, or none runs, has no entry. A name no machine
    captures is asked of the machine search order picks for it
    (``searched_machine``). Every machine is asked at once.

    Args:
        command (str): ``which``, ``type`` or ``command``.
        letters (str): the options the agent gave it.
        names (Sequence[str]): the names looked up.
        kind (ProgramLookup): what the lookup asks, by its
            ``PROGRAM_LOOKUPS`` row.
        past_functions (bool): the lookup finds the program a function
            of the same name shadows.
        session (SessionState): the session they are looked up in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        routing (RouteDecision | None): the line's placement.
    """
    asked: dict[str, RemoteRuntime] = {}
    for name in dict.fromkeys(names):
        runtime = lookup_machine(
            name, session, registry, routing, past_functions
        )
        if runtime is not None:
            searched = await searched_machine(
                name,
                [],
                session,
                registry,
                routing,
                past_functions=past_functions,
            )
            asked[name] = runtime if searched is None else searched
    found = await asyncio.gather(
        *(
            _answer(
                command,
                letters,
                name,
                kind,
                runtime,
                session,
                registry,
                links,
            )
            for name, runtime in asked.items()
        )
    )
    return dict(zip(asked, found, strict=True))
