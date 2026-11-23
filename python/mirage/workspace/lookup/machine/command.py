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

import posixpath
from collections.abc import Sequence

from mirage.commands.spec import SPECS, parse_command
from mirage.commands.spec.types import WordKind
from mirage.io.types import ByteSource
from mirage.policy.types import CommandWord
from mirage.rs.find import find_layout
from mirage.runtime.machine import RemoteRuntime
from mirage.types import PathSpec
from mirage.utils.glob_walk import unmark_globs
from mirage.utils.path import norm
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.expand.argv import Argv
from mirage.workspace.lookup.constants import FOLDER_FREE, NETWORK_CLIENTS
from mirage.workspace.lookup.machine.mounts import (
    is_piped,
    machine_holding_all,
    machine_mounts,
    mount_machines,
    only_machine,
)
from mirage.workspace.lookup.types import ExternalTarget
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState


def option_paths(argv: Argv, cwd: str) -> list[str]:
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


def path_operands(argv: Argv, cwd: str) -> list[PathSpec]:
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
    options = option_paths(argv, cwd)
    children = _child_paths(argv.name, argv.args, cwd)
    paths = [unmark_globs(w.virtual) for w in named]
    relative = (
        not path_operands(argv, cwd)
        or any(not w.raw_path.startswith("/") for w in named)
        or options != option_paths(argv, "/")
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
