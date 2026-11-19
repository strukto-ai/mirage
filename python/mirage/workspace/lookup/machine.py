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
import posixpath
from collections.abc import Sequence

from mirage.commands.spec import SPECS, parse_command
from mirage.core.machine.place import holders
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource
from mirage.rs.find import find_layout
from mirage.runtime.binding import restricted_mounts_for
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import DispatchFn, RouteDecision, RuntimeIdentity
from mirage.shell.bytes import decode_text
from mirage.shell.constants import BIN_PREFIX
from mirage.shell.join import shell_join
from mirage.types import MountMode, PathSpec
from mirage.utils.glob_walk import unmark_globs
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError, norm, parent
from mirage.utils.quote import shell_quote
from mirage.vfs.bin import BinViewVFS
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.expand.argv import Argv
from mirage.workspace.lookup.constants import KEYWORDS
from mirage.workspace.lookup.lookup import lookup_all
from mirage.workspace.lookup.types import (
    Consumer,
    MachineAnswer,
    ProgramLookup,
)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


def _local_mount(
    registry: MountRegistry, links: NamespaceReader, path: str, writes: bool
) -> MountEntry | None:
    """The machine mount showing ``path`` at the same path on its
    machines, with no other mount and no link of Mirage's own under the
    path; None for any other path, for one a write may not reach, and
    for one that walks through a link of Mirage's own, which the machine
    does not have. A name the ``/usr/bin`` view leaves to the mount
    beneath it is read from that mount, so ``/usr/bin/python3`` is the
    machine's own file where the machine's disk lies under the view.

    Args:
        registry (MountRegistry): the workspace's mounts.
        links (NamespaceReader): the session's link table.
        path (str): an absolute virtual path.
        writes (bool): whether the mount must take writes.
    """
    try:
        if norm(links.follow(norm(path))) != norm(path) or (
            links.link_stats_below(norm(path))
        ):
            return None
    except CycleError:
        logger.debug("%s: a link loop keeps it here", path, exc_info=True)
        return None
    entry = registry.try_mount_for(path)
    if (
        entry is not None
        and not writes
        and isinstance(entry.vfs, BinViewVFS)
        and entry.vfs.leaves(mount_key(path, entry.prefix))
    ):
        entry = registry.mount_beneath(entry, path)
    if entry is None or not isinstance(entry.vfs, MachineVFS):
        return None
    if norm(entry.vfs.config.root) != norm(entry.prefix):
        return None
    if writes and entry.mode is MountMode.READ:
        return None
    below = norm(path).rstrip("/") + "/"
    if any(
        m is not entry and norm(m.prefix).startswith(below)
        for m in registry.mounts()
    ):
        return None
    return entry


def _piped(stdin: ByteSource | None) -> bool:
    """Whether anything is piped in: the empty input ``xargs`` gives a
    command, as GNU's gives it ``/dev/null``, is none.

    Args:
        stdin (ByteSource | None): what is piped into the command.
    """
    return stdin is not None and stdin != b""


def _ruled(
    session: SessionState, registry: MountRegistry, entries: list[MountEntry]
) -> bool:
    prefixes = [m.prefix for m in registry.mounts()]
    restricted = {norm(p) for p in restricted_mounts_for(session, prefixes)}
    return any(norm(e.prefix) in restricted for e in entries)


async def _machine_holding(
    scopes: list[tuple[str, bool]],
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    stdin: ByteSource | None,
) -> RemoteRuntime | None:
    """The one machine holding every path, each its own at the same path
    on a machine mount the session may use; None when any path is
    elsewhere, no one machine holds them all, or input is piped into a
    machine that takes none.

    Args:
        scopes (list[tuple[str, bool]]): each absolute path, with whether
            the command may write it.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        stdin (ByteSource | None): what is piped into it.
    """
    entries = [
        _local_mount(registry, links, p, writes) for p, writes in scopes
    ]
    if not scopes or None in entries:
        return None
    mounts = [e for e in entries if e is not None]
    if _ruled(session, registry, mounts) or (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        return None
    candidates: list[str] | None = None
    for (path, _), entry in zip(scopes, mounts):
        assert isinstance(entry.vfs, MachineVFS)
        held = await holders(
            entry.vfs.accessor,
            PathSpec.from_str_path(path, mount_key(path, entry.prefix)),
        )
        candidates = (
            held
            if candidates is None
            else [m for m in candidates if m in held]
        )
    if candidates is None or len(candidates) != 1:
        return None
    runtime = next(
        (
            e
            for e in registry.runtime_entries
            if isinstance(e, RemoteRuntime) and e.default_machine in candidates
        ),
        None,
    )
    if runtime is None:
        return None
    if _piped(stdin) and not runtime.handle().takes_input:
        return None
    return runtime


def several_machines(registry: MountRegistry) -> bool:
    """Whether the workspace runs programs on more than one machine, the
    only case where which machine a command runs on decides where a new
    file lands.

    Args:
        registry (MountRegistry): the workspace's mounts and machines.
    """
    machines = {
        e.default_machine
        for e in registry.runtime_entries
        if isinstance(e, RemoteRuntime)
    }
    return len(machines) > 1


def _option_paths(argv: Argv, cwd: str) -> list[str]:
    """The paths a command's options name (``grep -f /data/patterns``),
    which the machine must hold as well as its operands; none for a
    command without a spec.

    Args:
        argv (Argv): the command.
        cwd (str): the directory a relative path resolves against.
    """
    spec = SPECS.get(argv.name)
    if spec is None:
        return []
    parsed = parse_command(spec, list(argv.args), cwd, argv.name)
    return [p for p in parsed.path_flag_values if p != "-"]


def _child_paths(argv: Argv, cwd: str) -> list[str]:
    """The paths a ``find -exec`` command names, which the machine must
    hold as well, since the classifier keeps its words as text: an
    absolute word, or one that climbs with ``..``. A word that is no path
    at all keeps the command in Mirage, which is always right.

    Args:
        argv (Argv): the command.
        cwd (str): the directory a relative word resolves against.
    """
    if argv.name != "find":
        return []
    words = list(argv.args)
    return [
        norm(posixpath.join(cwd, word))
        for start, end in find_layout(words).spans
        for word in words[start + 1 : end]
        if word.startswith("/") or ".." in word.split("/")
    ]


async def operand_machine(
    argv: Argv,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    stdin: ByteSource | None,
) -> RemoteRuntime | None:
    """The machine a mount command runs on whole, when every path it
    names is one machine's own at the same path: ``grep -rn x /testbed``
    is one exec there, with the machine's own output, where Mirage's
    implementation would read each file through an exec of its own.

    Mirage keeps the command when anything is piped into it, since its
    own command leaves input it does not read for the next one (``... |
    while read f; do grep x "$f"; done``) where a machine would drain it;
    when a path is anywhere else (another mount, a machine mount at
    another root, a mount nested under it); when no one machine holds
    every path (a new name, or a name on several machines, which Mirage
    places by its own rules); when the session's rules restrict its
    mount, a coded file policy speaks for the session, or the mount is
    read-only; when the cwd is not on the machine;
    when a path, an option's or a ``find -exec`` command's included,
    walks through a link of Mirage's own; or when the machine
    lacks the program. A command naming no path runs
    there from a cwd on the machine (``ls``, ``find``).

    Args:
        argv (Argv): the command.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        stdin (ByteSource | None): what is piped into it.
    """
    if _piped(stdin):
        return None
    paths = [
        unmark_globs(w.virtual)
        for w in argv.operands
        if isinstance(w, PathSpec)
    ]
    cwd = norm(session.cwd)
    paths += _option_paths(argv, session.cwd)
    paths += _child_paths(argv, session.cwd)
    scopes = [(p, True) for p in paths]
    if cwd != "/":
        scopes.append((cwd, False))
    runtime = await _machine_holding(scopes, session, registry, links, None)
    if runtime is None or not await runtime.handle().has_program(argv.name):
        return None
    return runtime


async def program_machine(
    path: str,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    dispatch: DispatchFn,
    stdin: ByteSource | None,
) -> RemoteRuntime | None:
    """The machine a program named by its path runs on, when the file is
    one machine's own at that path: the ``venv/bin/python`` a machine's
    ``python -m venv`` made in /tmp runs there, as bash runs it, where
    Mirage would read the binary and refuse it. The path is asked of the
    dispatcher first, so a hidden or refused path stays with Mirage,
    which words the refusal.

    Args:
        path (str): the head word, as typed.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        dispatch (DispatchFn): op dispatcher, which applies the session's
            hides and policies to the path.
        stdin (ByteSource | None): what is piped into it.
    """
    spec = PathSpec.from_str_path(path, cwd=session.cwd)
    if _local_mount(registry, links, spec.virtual, False) is None:
        return None
    try:
        await dispatch("stat", spec)
    except FS_ERRORS:
        logger.debug("%s: not run on its machine", path, exc_info=True)
        return None
    return await _machine_holding(
        [(spec.virtual, False)], session, registry, links, stdin
    )


async def link_machine(
    made: Sequence[tuple[str, str]],
    symbolic: bool,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> RemoteRuntime | None:
    """The machine an ``ln`` runs on whole, when every link lands in a
    folder one machine holds at its own path and points at that machine's
    own files: the machine makes the link, so its programs follow it,
    where Mirage's link table holds links only Mirage sees.

    A symbolic link's target counts when it resolves onto a machine mount
    at its own path, there or not, since a dangling link is a link all
    the same; a hard link's source must be one the machine holds.

    Args:
        made (Sequence[tuple[str, str]]): each link's absolute path and
            its target, resolved as the link will resolve it.
        symbolic (bool): whether the links are symbolic.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    if not made:
        return None
    if symbolic and any(
        _local_mount(registry, links, target, False) is None
        for _, target in made
    ):
        return None
    scopes = dict.fromkeys((parent(link), True) for link, _ in made)
    if not symbolic:
        scopes.update(dict.fromkeys((target, False) for _, target in made))
    runtime = await _machine_holding(
        list(scopes), session, registry, links, None
    )
    if runtime is None or not await runtime.handle().has_program("ln"):
        return None
    return runtime


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
    placement binds them (``ProgramLookup`` has the whole rule).

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
    return runtime if isinstance(runtime, RemoteRuntime) else None


def _lookup_line(command: str, letters: str, name: str) -> str:
    """The line a machine runs for a lookup: the command the agent typed,
    on this one name. ``type`` and ``command`` are bash's builtins, so
    they run in the machine's bash, its ``sh`` where it has none.

    Args:
        command (str): ``which``, ``type`` or ``command``.
        letters (str): the options the agent gave it.
        name (str): the name looked up.
    """
    line = shell_join([command, *([f"-{letters}"] if letters else []), name])
    if command == "which":
        return line
    quoted = shell_quote(line)
    return (
        f"if [ -x /bin/bash ]; then exec /bin/bash -c {quoted}; fi; "
        f"exec /bin/sh -c {quoted}"
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
    """What ``runtime``'s machine answers the lookup of one name, each
    path it prints kept only where Mirage shows that same path as the
    machine's own file, the name's ``/usr/bin`` file otherwise.

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
    done = await runtime.handle().look_up(_lookup_line(command, letters, name))
    lines: list[str] = []
    for line in decode_text(done.stdout).splitlines():
        path = _path_in(line, name, kind)
        if path is not None:
            held = await _machine_holding(
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
    Mirage answers for, or none runs, has no entry. Every machine is
    asked at once.

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
            asked[name] = runtime
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
