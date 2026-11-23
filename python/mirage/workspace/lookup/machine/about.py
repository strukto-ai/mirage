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

from mirage.commands.spec import SPECS, parse_command
from mirage.context import current_caller
from mirage.io.gateway import live_egress
from mirage.io.types import ByteSource
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.utils.glob_walk import unmark_globs
from mirage.utils.path import parent, resolve_path
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.expand.argv import Argv
from mirage.workspace.lookup.constants import (
    LOCALHOST_WORD,
    MACHINE_FACTS,
    NETWORK_CLIENTS,
)
from mirage.workspace.lookup.machine.command import option_paths, path_operands
from mirage.workspace.lookup.machine.mounts import (
    is_piped,
    machine_holding_all,
    machine_mounts,
    only_machine,
)
from mirage.workspace.lookup.machine.search import (
    folder_holders,
    holding_machines,
)
from mirage.workspace.lookup.types import ExternalTarget
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot


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
    typed = [w for w in path_operands(argv, cwd) if w.raw_path != "-"]
    options = option_paths(argv, cwd)
    if (typed or options or files) and (
        await registry.policies.wants_for("pre_vfs", session.session_id)
    ):
        return None
    here = runtime.default_machine in await folder_holders(
        cwd, session, registry, asked
    )
    leans = (
        options != option_paths(argv, "/")
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
