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
from mirage.commands.spec.types import WordKind
from mirage.core.machine.place import chosen, holders, new_name_machine
from mirage.core.machine.types import Holder
from mirage.core.machine.utils import folder_of
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource
from mirage.policy.types import CommandWord
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
from mirage.utils.path import CycleError, norm, parent, resolve_path
from mirage.utils.quote import shell_quote
from mirage.vfs.bin import BinViewVFS
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.expand.argv import Argv
from mirage.workspace.frame import PipeWriter
from mirage.workspace.lookup.constants import FOLDER_FREE, KEYWORDS
from mirage.workspace.lookup.lookup import (
    lookup_all,
    program_head,
    program_runtime,
)
from mirage.workspace.lookup.types import (
    Consumer,
    ExternalTarget,
    MachineAnswer,
    ProgramLookup,
)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState, env_snapshot

logger = logging.getLogger(__name__)


def _machine_mount(
    registry: MountRegistry, links: NamespaceReader, path: str, writes: bool
) -> MountEntry | None:
    """The machine mount showing ``path`` at the same path on its
    machines, with no other mount and no link of Mirage's own under the
    path; None for any other path, for one a write may not reach, and
    for one that walks through a link of Mirage's own, which the machine
    does not have. A name the ``/usr/bin`` view leaves to the mount
    beneath it is read from that mount, so ``/usr/bin/python3`` is the
    machine's own file where the machine's disk lies under the view.

    The link table is walked last: a path that is no machine's needs no
    look at it, and a folder of many links costs a walk of them all.

    Args:
        registry (MountRegistry): the workspace's mounts.
        links (NamespaceReader): the session's link table.
        path (str): an absolute virtual path.
        writes (bool): whether the mount must take writes.
    """
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
    try:
        if norm(links.follow(norm(path))) != norm(path) or (
            links.link_stats_below(norm(path))
        ):
            return None
    except CycleError:
        logger.debug("%s: a link loop keeps it here", path, exc_info=True)
        return None
    return entry


def _is_piped(stdin: ByteSource | None) -> bool:
    """Whether anything is piped in: the empty input ``xargs`` gives a
    command, as GNU's gives it ``/dev/null``, is none.

    Args:
        stdin (ByteSource | None): what is piped into the command.
    """
    return stdin is not None and stdin != b""


def _rules_restrict(
    session: SessionState, registry: MountRegistry, entries: list[MountEntry]
) -> bool:
    prefixes = [m.prefix for m in registry.mounts()]
    restricted = {norm(p) for p in restricted_mounts_for(session, prefixes)}
    return any(norm(e.prefix) in restricted for e in entries)


def _machine_mounts(
    scopes: list[tuple[str, bool]],
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> list[MountEntry] | None:
    """The machine mount showing each path at its own path, in order;
    None when there is no path, any path is elsewhere, or the session's
    rules restrict one of those mounts.

    Args:
        scopes (list[tuple[str, bool]]): each absolute path, with whether
            the command may write it.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    entries = [
        _machine_mount(registry, links, p, writes) for p, writes in scopes
    ]
    if not scopes or None in entries:
        return None
    mounts = [e for e in entries if e is not None]
    if _rules_restrict(session, registry, mounts):
        return None
    return mounts


def _only_machine(
    machines: Sequence[str], registry: MountRegistry
) -> RemoteRuntime | None:
    """The runtime that runs programs on the one machine named; None for
    none or several.

    Args:
        machines (Sequence[str]): the candidate machines.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    if len(machines) != 1:
        return None
    return next(
        (
            e
            for e in registry.runtime_entries
            if isinstance(e, RemoteRuntime)
            and e.default_machine == machines[0]
        ),
        None,
    )


def _mount_machines(entry: MountEntry, registry: MountRegistry) -> list[str]:
    """The machines a machine mount shows, by its config: the ones it
    names, else every machine the workspace runs programs on.

    Args:
        entry (MountEntry): a machine mount.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    assert isinstance(entry.vfs, MachineVFS)
    named = entry.vfs.config.machines
    if named is not None:
        return list(named)
    return sorted(
        {
            e.default_machine
            for e in registry.runtime_entries
            if isinstance(e, RemoteRuntime)
        }
    )


async def _machine_holding_all(
    scopes: list[tuple[str, bool]],
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    stdin: ByteSource | None,
    folder: str | None = None,
) -> RemoteRuntime | None:
    """The one machine holding every path, each its own at the same path
    on a machine mount the session may use, and the folder it runs from;
    None when any path is elsewhere, no one machine holds them all, or
    input is piped into a machine that takes none. A name several
    machines hold is no one machine's to answer for: Mirage shows it as
    one (``chosen``), so the command stays with Mirage. The folder a
    command only runs from may be on several.

    Args:
        scopes (list[tuple[str, bool]]): each absolute path, with whether
            the command may write it.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        stdin (ByteSource | None): what is piped into it.
        folder (str | None): the folder it runs from, which the machine
            must hold too; None for one that runs from ``/``.
    """
    stood = [] if folder is None else [(folder, False)]
    mounts = _machine_mounts([*scopes, *stood], session, registry, links)
    if mounts is None or (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        return None
    candidates: list[str] | None = None
    for at, ((path, _), entry) in enumerate(zip([*scopes, *stood], mounts)):
        assert isinstance(entry.vfs, MachineVFS)
        held = [
            one.machine
            for one in await holders(
                entry.vfs.accessor,
                _path_on_mount(entry, path),
            )
        ]
        if len(held) > 1 and at < len(scopes):
            return None
        candidates = (
            held
            if candidates is None
            else [m for m in candidates if m in held]
        )
    runtime = _only_machine(candidates or [], registry)
    if runtime is None:
        return None
    if _is_piped(stdin) and not runtime.handle().takes_input:
        return None
    return runtime


async def preferred_machine(
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    fed_by: PipeWriter | None,
    namespace: Namespace,
    dispatch: DispatchFn,
) -> str | None:
    """The machine a command Mirage runs itself is about
    (``Caller.preferred_machine``): the one the line names, else the one
    whose program writes the pipe it reads, else the one its folder is
    on; None when nothing says, and in a workspace that runs programs on
    one machine, where nothing is to choose.

    A pipe's writer is placed once for the pipe, so a reader that moves
    (``gen | (cd /srv; tee log)``) or runs many commands asks no more.

    Args:
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement.
        fed_by (PipeWriter | None): the program writing the pipe the
            command reads.
        namespace (Namespace): the link table a writer's path is read
            through.
        dispatch (DispatchFn): op dispatcher, which a writer's path is
            asked of.
    """
    if routing is None or not several_machines(registry):
        return None
    if routing.machine is not None:
        return routing.machine
    if fed_by is not None and not fed_by.placed:
        fed_by.machine = await _writer_machine(
            fed_by, session, registry, routing, namespace, dispatch
        )
        fed_by.placed = True
    if fed_by is not None and fed_by.machine is not None:
        return fed_by.machine
    shown = _folder_machines(session.cwd, registry)
    return shown[0] if len(shown) == 1 else None


async def _writer_machine(
    fed_by: PipeWriter,
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity],
    namespace: Namespace,
    dispatch: DispatchFn,
) -> str | None:
    """The machine a pipe's writer runs on, placed as it runs, from the
    folder its pipeline started in: by its words, through the wrappers
    Mirage runs (``nice gen | tee log``), and one named by its path on
    the machine holding that file (``nice /tmp/tool | tee log``). None
    for a program Mirage runs itself, and for one that would not start in
    that folder as far as the mounts tell, which writes nothing: it
    starts where the folder is ``/``, the machine's own, or Mirage's
    mounts are served into the machine.

    A path is looked up only when no file policy speaks for the session:
    the lookup asks the dispatcher before the reader is admitted, and a
    policy judges a call inside the command that makes it.

    Args:
        fed_by (PipeWriter): the pipe's writer.
        session (SessionState): the session its reader runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision): the line's placement.
        namespace (Namespace): the link table the path is read through.
        dispatch (DispatchFn): op dispatcher, which the path is asked of.
    """
    head = program_head(registry, fed_by.words, session, routing)
    runtime: RuntimeIdentity | None = None
    if "/" in head and not (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        runtime = await program_machine(
            PathSpec.from_str_path(head, cwd=fed_by.cwd).virtual,
            session,
            registry,
            namespace.session_links(session),
            dispatch,
            None,
        )
    if runtime is None:
        runtime = program_runtime(registry, fed_by.words, session, routing)
    if not isinstance(runtime, RemoteRuntime):
        return None
    name = runtime.default_machine
    if (
        norm(fed_by.cwd) == "/"
        or runtime.handle().config.mount_type is not None
    ):
        return name
    return name if name in _folder_machines(fed_by.cwd, registry) else None


def _folder_machines(folder: str, registry: MountRegistry) -> list[str]:
    """The machines whose own files a folder is, by the mount showing it
    (``/srv/gpu`` over the gpu machine, ``/tmp`` over every machine);
    none for a folder in a store.

    Args:
        folder (str): the folder, an absolute virtual path.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    entry = registry.try_mount_for(folder)
    if entry is None or not isinstance(entry.vfs, MachineVFS):
        return []
    return _mount_machines(entry, registry)


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


def _path_operands(argv: Argv, cwd: str) -> list[PathSpec]:
    """The paths a command takes as operands, the files it works on, and
    not as an option's value: ``grep -r -f /tmp/p`` takes none, so it
    searches its folder. Every path for a command without a spec.

    Args:
        argv (Argv): the command.
        cwd (str): the directory a relative path resolves against.
    """
    words = list(argv.operands)
    spec = SPECS.get(argv.name)
    if spec is None:
        return [w for w in words if isinstance(w, PathSpec)]
    roles = parse_command(spec, list(argv.args), cwd, argv.name).word_roles
    return [
        w
        for w, role in zip(words, roles, strict=False)
        if role is WordKind.OPERAND and isinstance(w, PathSpec)
    ]


def _child_paths(name: str, words: Sequence[str], cwd: str) -> list[str]:
    """The paths a ``find -exec`` command names, which the machine must
    hold as well, since the classifier keeps its words as text: an
    absolute word, or one that climbs with ``..``. A word that is no path
    at all keeps the command in Mirage, which is always right.

    Args:
        name (str): the command's name.
        words (Sequence[str]): its words after the name.
        cwd (str): the directory a relative word resolves against.
    """
    if name != "find":
        return []
    return [
        norm(posixpath.join(cwd, word))
        for start, end in find_layout(words).spans
        for word in words[start + 1 : end]
        if word.startswith("/") or ".." in word.split("/")
    ]


def _named_paths(argv: Argv, cwd: str) -> tuple[list[str], bool]:
    """Every path a command names, absolute, with whether any of them
    depends on the folder it runs from: an operand typed relative, an
    option's path the folder changes, or no path operand at all (``ls``
    and ``grep -r -f /tmp/p`` read the folder).

    Args:
        argv (Argv): the command.
        cwd (str): the session's folder.
    """
    named = [w for w in argv.operands if isinstance(w, PathSpec)]
    options = _option_paths(argv, cwd)
    children = _child_paths(argv.name, argv.args, cwd)
    paths = [unmark_globs(w.virtual) for w in named]
    relative = (
        not _path_operands(argv, cwd)
        or any(not w.raw_path.startswith("/") for w in named)
        or options != _option_paths(argv, "/")
    )
    return [*paths, *options, *children], relative


async def operand_machine(
    argv: Argv,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    stdin: ByteSource | None,
) -> ExternalTarget | None:
    """The machine a mount command runs on whole, when every path it
    names is one machine's own at the same path: ``grep -rn x /testbed``
    is one exec there, with the machine's own output, where Mirage's
    implementation would read each file through an exec of its own. Its
    output is then the machine's in every detail, its links and its
    ``/proc`` included.

    It runs from the session's folder when that folder is on the same
    machine. A command that touches nothing but the paths it names
    (``FOLDER_FREE``), every one absolute, runs there from ``/``
    otherwise, since nothing it does depends on the folder (``ls
    /proc/self/fd`` from a Mirage store); any other needs the folder on
    the machine.

    Mirage keeps the command when anything is piped into it, since its
    own command leaves input it does not read for the next one (``... |
    while read f; do grep x "$f"; done``) where a machine would drain it;
    when a path is anywhere else (another mount, a machine mount at
    another root, a mount nested under it); when no one machine holds
    every path (a new name, or a name on several machines, which Mirage
    places by its own rules); when the session's rules restrict its
    mount, a coded file policy speaks for the session, or the mount is
    read-only; when a path, an option's or a ``find -exec`` command's
    included, walks through a link of Mirage's own; or when the machine
    lacks the program. ``stated_machine`` is the same rule as far as a
    command's words tell it.

    Args:
        argv (Argv): the command.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        stdin (ByteSource | None): what is piped into it.
    """
    if _is_piped(stdin):
        return None
    paths, relative = _named_paths(argv, session.cwd)
    scopes = [(p, True) for p in paths]
    cwd = norm(session.cwd)
    runtime = await _machine_holding_all(
        scopes, session, registry, links, None, None if cwd == "/" else cwd
    )
    runs_from: str | None = None
    if (
        runtime is None
        and not relative
        and cwd != "/"
        and argv.name in FOLDER_FREE
    ):
        runtime = await _machine_holding_all(
            scopes, session, registry, links, None
        )
        runs_from = "/"
    if runtime is None or not await runtime.handle().has_program(argv.name):
        return None
    return ExternalTarget(runtime, runs_from)


def stated_machine(
    words: Sequence[CommandWord],
    cwd: str,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> RemoteRuntime | None:
    """The machine a mount command runs on whole as far as its words
    tell, without asking anything (``explain``): ``operand_machine``'s
    rule over the paths its operands, options and ``find -exec`` command
    name, where each mount
    shows one machine, for a session no coded file policy speaks for
    (the caller asks, ``wants_for``). What only a machine or the run can
    tell is left to the run, which keeps the command in Mirage: which of
    several machines a mount shows holds a name, whether the machine has
    the program, and input piped in.

    Args:
        words (Sequence[CommandWord]): the command's words, as judged.
        cwd (str): the session's folder.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    named = [
        w.path
        for w in words
        if w.path is not None
        and w.kind in (WordKind.OPERAND, WordKind.VALUE, WordKind.OPTION)
    ]
    name = next((w.text for w in words if w.kind is WordKind.NAME), "")
    args = [
        w.text
        for w in words
        if w.kind not in (WordKind.NAME, WordKind.REDIRECT)
    ]
    children = _child_paths(name, args, cwd)
    relative = not any(
        w.kind is WordKind.OPERAND for w in words if w.path
    ) or any(not p.raw_path.startswith("/") for p in named)
    scopes = [
        *((unmark_globs(p.virtual), True) for p in named),
        *((c, True) for c in children),
    ]
    here = norm(cwd)
    tries = [scopes] if here == "/" else [[*scopes, (here, False)]]
    if not relative and here != "/" and name in FOLDER_FREE:
        tries.append(scopes)
    for scoped in tries:
        mounts = _machine_mounts(scoped, session, registry, links)
        if mounts is None:
            continue
        machines: list[str] | None = None
        for at, entry in enumerate(mounts):
            shown = _mount_machines(entry, registry)
            # Only the run finds who holds a name several machines show.
            if len(shown) > 1 and at < len(scopes):
                machines = []
                break
            machines = (
                shown
                if machines is None
                else [m for m in machines if m in shown]
            )
        runtime = _only_machine(machines or [], registry)
        if runtime is not None:
            return runtime
    return None


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
    if _machine_mount(registry, links, spec.virtual, False) is None:
        return None
    try:
        await dispatch("stat", spec)
    except FS_ERRORS:
        logger.debug("%s: not run on its machine", path, exc_info=True)
        return None
    return await _machine_holding_all(
        [(spec.virtual, False)], session, registry, links, stdin
    )


async def link_machine(
    made: Sequence[tuple[str, str]],
    symbolic: bool,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    absolute: bool,
) -> ExternalTarget | None:
    """The machine an ``ln`` runs on whole, when one machine can make
    every link (``_linking_machine``): the machine makes the link, so its
    programs follow it, where Mirage's link table holds links only
    Mirage sees.

    It runs from the session's folder when the machine holds that folder.
    From any other folder it runs from ``/`` when every path it names is
    absolute, and stays with Mirage otherwise, since the machine could
    not resolve a relative name.

    Args:
        made (Sequence[tuple[str, str]]): each link's absolute path and
            its target, resolved as the link will resolve it.
        symbolic (bool): whether the links are symbolic.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        absolute (bool): whether every path the command names, that the
            folder it runs from could change, is typed absolute.
    """
    if not made:
        return None
    runtime = await _linking_machine(made, symbolic, session, registry, links)
    if runtime is None or not await runtime.handle().has_program("ln"):
        return None
    cwd = norm(session.cwd)
    if cwd == "/" or await _holds_folder(
        runtime, cwd, session, registry, links
    ):
        return ExternalTarget(runtime)
    return ExternalTarget(runtime, "/") if absolute else None


def _path_on_mount(entry: MountEntry, path: str) -> PathSpec:
    """A virtual path as its mount addresses it, the mount's own root
    included.

    Args:
        entry (MountEntry): the mount showing the path.
        path (str): an absolute virtual path on it.
    """
    return PathSpec.from_str_path(
        path, mount_key(path, entry.prefix.rstrip("/"))
    )


async def _holds_folder(
    runtime: RemoteRuntime,
    folder: str,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> bool:
    """Whether a machine holds a folder at its own path, so a program
    there can run from it.

    Args:
        runtime (RemoteRuntime): the machine's runtime.
        folder (str): the folder, an absolute virtual path.
        session (SessionState): the session.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    mounts = _machine_mounts([(folder, False)], session, registry, links)
    if mounts is None:
        return False
    entry = mounts[0]
    assert isinstance(entry.vfs, MachineVFS)
    held = await holders(entry.vfs.accessor, _path_on_mount(entry, folder))
    return any(
        one.machine == runtime.default_machine and _may_be_folder(one)
        for one in held
    )


def _may_be_folder(one: Holder) -> bool:
    """Whether a machine holds a folder at a name as far as is known: a
    mount on one machine asks nothing, so its machine answers for itself.

    Args:
        one (Holder): the machine and what it reports for the name.
    """
    return one.is_folder or one.entry is None


async def _linking_machine(
    made: Sequence[tuple[str, str]],
    symbolic: bool,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> RemoteRuntime | None:
    """The one machine that makes every link, when one can. A link is
    made on the machine holding its target, the copy shown of it
    (``chosen``), so the link leads where Mirage reads the target; a
    symbolic link to a name no machine holds is a new name like any
    other (``new_name_machine``). That machine must hold the link's
    folder, whose copy shown is a folder, and no other machine may hold
    the link's name, which Mirage's own ``ln`` then answers for.

    None when a path is off a machine mount, the session's rules or a
    coded file policy speak for the mount, a hard link's target is
    missing, or the links land on different machines: the links are then
    Mirage's own.

    Args:
        made (Sequence[tuple[str, str]]): each link's absolute path and
            its target, resolved as the link will resolve it.
        symbolic (bool): whether the links are symbolic.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    scopes = [
        *((parent(link), True) for link, _ in made),
        *((target, False) for _, target in made),
    ]
    mounts = _machine_mounts(scopes, session, registry, links)
    if mounts is None or (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        return None
    machines: set[str] = set()
    for at, (link, target) in enumerate(made):
        folder, aimed = mounts[at], mounts[len(made) + at]
        assert isinstance(folder.vfs, MachineVFS)
        assert isinstance(aimed.vfs, MachineVFS)
        spec = _path_on_mount(folder, link)
        held = await holders(aimed.vfs.accessor, _path_on_mount(aimed, target))
        if held:
            machine = chosen(aimed.vfs.accessor, held).machine
        elif symbolic:
            try:
                machine = await new_name_machine(folder.vfs.accessor, spec)
            except NotADirectoryError:
                logger.debug("%s: its folder is a file", link, exc_info=True)
                return None
        else:
            return None
        above = await holders(folder.vfs.accessor, folder_of(spec))
        if not above or not _may_be_folder(chosen(folder.vfs.accessor, above)):
            return None
        if not any(
            one.machine == machine and _may_be_folder(one) for one in above
        ):
            return None
        if len(above) > 1 and any(
            one.machine != machine
            for one in await holders(folder.vfs.accessor, spec)
        ):
            return None
        machines.add(machine)
    return _only_machine(sorted(machines), registry)


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
            held = await _machine_holding_all(
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
