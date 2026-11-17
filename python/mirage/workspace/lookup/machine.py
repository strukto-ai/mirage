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

import logging
from collections.abc import Sequence

from mirage.commands.spec import SPECS, parse_command
from mirage.core.machine.place import holders
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource
from mirage.runtime.binding import restricted_mounts_for
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import DispatchFn
from mirage.types import MountMode, PathSpec
from mirage.utils.glob_walk import unmark_globs
from mirage.utils.path import CycleError, norm, parent
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.expand.argv import Argv
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
    does not have.

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
        _, key, _ = registry.resolve(path)
        held = await holders(
            entry.vfs.accessor, PathSpec.from_str_path(path, key.strip("/"))
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
    when a path, an option's included, walks through a link of Mirage's
    own; or when the machine
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
