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
import posixpath
from collections.abc import Sequence

from mirage.commands.spec import SPECS, parse_command
from mirage.commands.spec.types import WordKind
from mirage.context import current_caller
from mirage.core.machine.place import holders
from mirage.errors.constants import FS_ERRORS
from mirage.io.gateway import live_egress
from mirage.io.types import ByteSource
from mirage.policy.types import CommandWord
from mirage.rs.find import find_layout
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import DispatchFn, RouteDecision, RuntimeIdentity
from mirage.types import PathSpec
from mirage.utils.glob_walk import unmark_globs
from mirage.utils.path import norm, parent, resolve_path
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.expand.argv import Argv
from mirage.workspace.lookup.constants import (
    FOLDER_FREE,
    LOCALHOST_WORD,
    MACHINE_FACTS,
    NETWORK_CLIENTS,
)
from mirage.workspace.lookup.machine.mounts import (
    is_piped,
    machine_holding_all,
    machine_mounts,
    mount_machines,
    only_machine,
    path_on_mount,
)
from mirage.workspace.lookup.machine.search import (
    folder_holders,
    holding_machines,
    nearest_machine,
)
from mirage.workspace.lookup.types import ExternalTarget
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot

logger = logging.getLogger(__name__)


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
    when it reaches a server (``NETWORK_CLIENTS``), whose connections
    the workspace's network rule and policies judge inside Mirage, one
    to ``localhost`` being ``fact_machine``'s; when a path is anywhere
    else (another mount, a machine mount at another root, a mount nested
    under it); when no one machine holds every path (a new name, or a
    name on several machines, which Mirage places by its own rules);
    when the session's rules restrict its
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
    if is_piped(stdin) or argv.name in NETWORK_CLIENTS:
        return None
    paths, relative = _named_paths(argv, session.cwd)
    scopes = [(p, True) for p in paths]
    cwd = norm(session.cwd)
    runtime = await machine_holding_all(
        scopes, session, registry, links, None, None if cwd == "/" else cwd
    )
    runs_from: str | None = None
    if (
        runtime is None
        and not relative
        and cwd != "/"
        and argv.name in FOLDER_FREE
    ):
        runtime = await machine_holding_all(
            scopes, session, registry, links, None
        )
        runs_from = "/"
    if runtime is None or not await runtime.handle().has_program(argv.name):
        return None
    return ExternalTarget(runtime, runs_from)


def about_machine(
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
) -> RemoteRuntime | None:
    """The machine a command that asks about its machine is about: the
    one its line names, else the one a command Mirage runs itself prefers
    (``Caller.preferred_machine``: the machine whose program writes its
    pipe, or the one machine holding its folder), else the first that
    takes programs no name captures, where the session's programs run.
    None where no machine takes them.

    Args:
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement.
    """
    if routing is None:
        return None
    told = (
        routing.machine
        if routing.machine is not None
        else current_caller().preferred_machine
    )
    if told is not None:
        return only_machine([told], registry)
    first = routing.bindings.get(EXTERNAL_COMMANDS)
    return first if isinstance(first, RemoteRuntime) else None


def asks_about_machine(argv: Argv) -> bool:
    """Whether a command of Mirage's own asks about the machine it runs
    on: one that reports a machine's facts (``MACHINE_FACTS``), or one
    that reaches a server at ``localhost`` (``NETWORK_CLIENTS``).

    Args:
        argv (Argv): the command.
    """
    if argv.name in MACHINE_FACTS:
        return True
    return argv.name in NETWORK_CLIENTS and any(
        LOCALHOST_WORD.fullmatch(word) for word in argv.args
    )


def _client_files(argv: Argv, cwd: str) -> list[str] | None:
    """The files a client that reaches a server reads or writes through
    words its spec keeps as text, as typed: curl's ``@file`` data and
    ``-w @file`` template, the cookie file a ``-b`` without ``=`` names,
    and, for wget with neither ``-O`` nor ``--spider``, its folder
    itself (``.``), where it saves under a name it picks as it runs
    (``report.1`` when ``report`` is there). None where Mirage cannot
    tell which files the program touches: an option its spec does not
    know, a ``-F`` field read from a file, which Mirage's curl sends as
    given, and a second wget operand, a URL to the machine's wget and a
    destination to Mirage's.

    Args:
        argv (Argv): the command, one of ``NETWORK_CLIENTS``.
        cwd (str): the directory a relative path resolves against.
    """
    parsed = parse_command(SPECS[argv.name], list(argv.args), cwd, argv.name)
    if parsed.option_error_kinds:
        return None
    flags = parsed.flags
    if argv.name == "wget":
        urls = [word for word, _ in parsed.raw_operands]
        if len(urls) > 1:
            return None
        if "-O" in flags or flags.get("--spider"):
            return []
        return ["."]
    form = flags.get("--form")
    if isinstance(form, str) and form.partition("=")[2][:1] in ("@", "<"):
        return None
    named: list[str] = []
    for key in ("--data", "--data-binary", "--json"):
        given = flags.get(key)
        for value in given if isinstance(given, list) else []:
            if value.startswith("@"):
                named.append(value[1:])
    encoded = flags.get("--data-urlencode")
    for value in encoded if isinstance(encoded, list) else []:
        sep = value.find("=")
        if sep < 0:
            sep = value.find("@")
        if sep >= 0 and value[sep] == "@":
            named.append(value[sep + 1 :])
    cookies = flags.get("--cookie")
    for value in cookies if isinstance(cookies, list) else []:
        if "=" not in value:
            named.append(value)
    template = flags.get("--write-out")
    if isinstance(template, str) and template.startswith("@"):
        named.append(template[1:])
    return [name for name in named if name not in ("", "-")]


async def _written_scope(
    path: str,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
) -> str | None:
    """The path a machine must hold for a command that writes ``path``
    to run there: ``path`` where a machine holds it, else its folder,
    where the new file lands. None where a write may not reach it on
    a machine (``machine_mounts``): another mount, a read-only one, a
    mount the session's rules restrict, or a link of Mirage's own on
    the way, the name itself included.

    Args:
        path (str): an absolute virtual path the command writes.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
    """
    if machine_mounts([(path, True)], session, registry, links) is None:
        return None
    if await holding_machines(path, registry):
        return path
    return parent(path)


async def fact_machine(
    argv: Argv,
    session: SessionState,
    registry: MountRegistry,
    links: NamespaceReader,
    routing: RouteDecision[RuntimeIdentity] | None,
    stdin: ByteSource | None,
    asked: dict[str, list[str]],
) -> ExternalTarget | None:
    """The machine a command that asks about its machine runs on whole
    (``asks_about_machine``): ``uname -m`` is the machine's own answer,
    where Mirage's is no machine's, and ``curl localhost:8000`` reaches
    the server a program of the session started there. It runs from the
    session's folder when the machine holds it, else from ``/``.

    Mirage keeps the command where no machine takes programs
    (``about_machine``), or that machine refuses the session's runs or
    would not find the program on the PATH the run gets; when a path it
    names or a file it reads or writes is not that machine's own, a
    file it writes counting by its folder while no machine holds it
    (``_written_scope``), or is typed relative to a folder the machine
    does not hold; when a coded file policy speaks for the session and
    the command touches a path, which the policy judges inside Mirage;
    when input is piped into a machine that takes none; and, for a
    command that reaches a server, when the workspace limits its network
    or a policy watches its connections, which only Mirage judges, or
    when Mirage cannot tell which files it touches (``_client_files``).

    Args:
        argv (Argv): the command.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        routing (RouteDecision | None): the line's placement.
        stdin (ByteSource | None): what is piped into it.
        asked (dict[str, list[str]]): the machines the line found
            holding its folders (``ExecutionFrame.folder_holders``).
    """
    if not asks_about_machine(argv):
        return None
    runtime = about_machine(registry, routing)
    if runtime is None or runtime.refuses_session():
        return None
    if is_piped(stdin) and not runtime.handle().takes_input:
        return None
    client = argv.name in NETWORK_CLIENTS
    if client and any(
        egress.rule is not None or egress.hooked for egress in live_egress()
    ):
        return None
    cwd = session.cwd
    files = _client_files(argv, cwd) if client else []
    if files is None:
        return None
    typed = [w for w in _path_operands(argv, cwd) if w.raw_path != "-"]
    options = _option_paths(argv, cwd)
    if (typed or options or files) and (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        return None
    here = runtime.default_machine in await folder_holders(
        cwd, session, registry, asked
    )
    leans = (
        options != _option_paths(argv, "/")
        or any(not w.raw_path.startswith("/") for w in typed)
        or any(not name.startswith("/") for name in files)
    )
    if leans and not here:
        return None
    written: list[str] = []
    for path in options:
        scope = await _written_scope(path, session, registry, links)
        if scope is None:
            return None
        written.append(scope)
    paths = [
        *(unmark_globs(w.virtual) for w in typed),
        *written,
        *(resolve_path(name, cwd) for name in files),
    ]
    if paths:
        held = await machine_holding_all(
            [(p, True) for p in paths], session, registry, links, None
        )
        if held is not runtime:
            return None
    if not await runtime.handle().finds_program(
        argv.name, env_snapshot(session).get("PATH"), cwd if here else "/"
    ):
        return None
    return ExternalTarget(runtime, None if here else "/")


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
    if name in NETWORK_CLIENTS:
        return None
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
        mounts = machine_mounts(scoped, session, registry, links)
        if mounts is None:
            continue
        machines: list[str] | None = None
        for at, entry in enumerate(mounts):
            shown = mount_machines(entry, registry)
            # Only the run finds who holds a name several machines show.
            if len(shown) > 1 and at < len(scopes):
                machines = []
                break
            machines = (
                shown
                if machines is None
                else [m for m in machines if m in shown]
            )
        runtime = only_machine(machines or [], registry)
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
    named: str | None = None,
    paths: Sequence[str] = (),
    cwd: str | None = None,
) -> RemoteRuntime | None:
    """The machine a program named by its path runs on, when the file is
    a machine's own at that path: the ``venv/bin/python`` a machine's
    ``python -m venv`` made in /tmp runs there, as bash runs it, where
    Mirage would read the binary and refuse it. A file several machines
    hold runs on the one the line names when it holds the file, else on
    the one search order picks among them (``nearest_machine``), and is
    never read into Mirage. The path is asked of the dispatcher first, so
    a hidden or refused path stays with Mirage, which words the refusal.

    Args:
        path (str): the head word, as typed.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        links (NamespaceReader): the session's link table.
        dispatch (DispatchFn): op dispatcher, which applies the session's
            hides and policies to the path.
        stdin (ByteSource | None): what is piped into it.
        named (str | None): the machine the line names.
        paths (Sequence[str]): the absolute paths the command names.
        cwd (str | None): the folder it runs from; None for the
            session's own.
    """
    here = session.cwd if cwd is None else cwd
    spec = PathSpec.from_str_path(path, cwd=session.cwd)
    mounts = machine_mounts([(spec.virtual, False)], session, registry, links)
    if mounts is None:
        return None
    try:
        await dispatch("stat", spec)
    except FS_ERRORS:
        logger.debug("%s: not run on its machine", path, exc_info=True)
        return None
    if await registry.policies.wants_for("pre_vfs", session.session_id):
        return None
    entry = mounts[0]
    assert isinstance(entry.vfs, MachineVFS)
    held = [
        one.machine
        for one in await holders(
            entry.vfs.accessor, path_on_mount(entry, spec.virtual)
        )
    ]
    machine = (
        named
        if named in held
        else await nearest_machine(held, here, paths, session, registry)
    )
    runtime = only_machine([] if machine is None else [machine], registry)
    if runtime is None:
        return None
    if is_piped(stdin) and not runtime.handle().takes_input:
        return None
    return runtime
