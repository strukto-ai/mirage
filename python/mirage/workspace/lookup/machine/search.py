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
import dataclasses
import logging
from collections.abc import Sequence

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine.place import kernel_view_machine
from mirage.core.machine.stat import is_hidden_on, stat_entry
from mirage.errors.types import CommandTimeoutError
from mirage.runtime.constants import EXTERNAL_COMMANDS, WHOLE_LINE
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import RouteDecision, RuntimeIdentity
from mirage.types import PathSpec
from mirage.utils.abort import MirageAbortError
from mirage.vfs.machine.machine import MachineVFS
from mirage.workspace.lookup.lookup import lookup, lookup_all
from mirage.workspace.lookup.machine.mounts import (
    folder_machines,
    mount_machines,
    path_on_mount,
)
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState, env_snapshot

logger = logging.getLogger(__name__)


def searched_machines(registry: MountRegistry) -> list[RemoteRuntime]:
    """The machines a program no name captures is searched for on, in
    the order ``machines:`` lists them.

    Args:
        registry (MountRegistry): the workspace's mounts and machines.
    """
    return [
        entry
        for entry in registry.runtime_entries
        if isinstance(entry, RemoteRuntime)
        and EXTERNAL_COMMANDS in entry.captures
    ]


def is_searched(
    name: str,
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    past_functions: bool = False,
) -> bool:
    """Whether search order places a program: one a machine runs because
    no name captures it, on a line that names no machine and no runtime
    takes whole, in a workspace where several machines take such
    programs. A machine that refuses the session's runs is asked nothing,
    so its refusal stays the answer.

    Args:
        name (str): the program's name.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement.
        past_functions (bool): the program a function of the same
            name shadows is the one asked about (``which``).
    """
    if routing is None or routing.machine is not None:
        return False
    bindings = routing.bindings
    if not name or "/" in name or name in bindings or WHOLE_LINE in bindings:
        return False
    first = bindings.get(EXTERNAL_COMMANDS)
    if not isinstance(first, RemoteRuntime) or first.refuses_session():
        return False
    if len(searched_machines(registry)) < 2:
        return False
    if not past_functions:
        return lookup(name, session, registry, routing) is Consumer.EXTERNAL
    return all(
        layer in (Consumer.FUNCTION, Consumer.EXTERNAL)
        for layer in lookup_all(name, session, registry, routing)
    )


def _unasked(failure: BaseException, what: str) -> None:
    """Note a machine that could not be asked, which search order then
    counts out; a run that was killed or timed out stops instead.

    Args:
        failure (BaseException): what asking raised.
        what (str): what was asked, for the log.

    Raises:
        BaseException: the failure, when it ends the run.
    """
    if not isinstance(failure, Exception) or isinstance(
        failure, (CommandTimeoutError, MirageAbortError)
    ):
        raise failure
    logger.debug(
        "%s: not asked, so it decides nothing", what, exc_info=failure
    )


async def holding_machines(path: str, registry: MountRegistry) -> list[str]:
    """The machines holding a path as their own file or folder, by the
    machine mount showing it; none for a path in a store and for a name
    no machine holds yet. A machine that cannot be asked counts as not
    holding it, and the others' answers stand, so a machine that is down
    neither stops a program nor hides who holds its path.

    Args:
        path (str): an absolute virtual path.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    entry = registry.try_mount_for(path)
    if entry is None or not isinstance(entry.vfs, MachineVFS):
        return []
    shown = mount_machines(entry, registry)
    if len(shown) < 2:
        return shown
    accessor = entry.vfs.accessor
    spec = path_on_mount(entry, path)
    own = kernel_view_machine(accessor, spec)
    names = [n for n in accessor.names() if own in (None, n)]
    found = await asyncio.gather(
        *(_holds(accessor, name, spec) for name in names),
        return_exceptions=True,
    )
    held: list[str] = []
    for name, result in zip(names, found, strict=True):
        if isinstance(result, BaseException):
            _unasked(result, f"{name} for {path}")
        elif result:
            held.append(name)
    return held


async def _holds(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> bool:
    """Whether one machine holds a path the session may see: not one its
    own links lead to a hidden name (``is_hidden_on``), and one it has.
    Each machine is asked on its own, so one that cannot be asked fails
    alone.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine asked.
        path (PathSpec): the path, as its mount addresses it.
    """
    if await is_hidden_on(accessor, machine, path):
        return False
    try:
        await stat_entry(accessor, machine, path)
    except (FileNotFoundError, NotADirectoryError):
        return False
    return True


async def _machines_with(
    name: str,
    path: str | None,
    cwd: str,
    machines: Sequence[RemoteRuntime],
) -> list[RemoteRuntime]:
    """The machines a run started now would find a program on
    (``finds_program``), in the order given. One that cannot be asked,
    such as a machine that is down, counts as lacking it.

    Args:
        name (str): the program's name.
        path (str | None): the PATH the run gets; None for each
            machine's own.
        cwd (str): the folder the run starts in.
        machines (Sequence[RemoteRuntime]): the machines to ask.
    """
    asked = await asyncio.gather(
        *(m.handle().finds_program(name, path, cwd) for m in machines),
        return_exceptions=True,
    )
    having: list[RemoteRuntime] = []
    for machine, found in zip(machines, asked, strict=True):
        if isinstance(found, BaseException):
            _unasked(found, f"{machine.default_machine} for {name}")
        elif found:
            having.append(machine)
    return having


async def nearest_machine(
    machines: Sequence[str],
    cwd: str,
    paths: Sequence[str],
    session: SessionState,
    registry: MountRegistry,
) -> str | None:
    """Of the machines that can run a program, the one search order
    picks: one the session's folder is on, then one holding the paths
    the command names, then the first ``machines:`` lists. Each step
    narrows the machines left only when it leaves any, so a folder every
    machine has decides nothing and the paths are asked next.

    Where a coded file policy speaks for the session no machine is asked
    about a path, which the policy judges inside the command that opens
    it: the first machine is the answer.

    Args:
        machines (Sequence[str]): the machines that can run it, in the
            order ``machines:`` lists them.
        cwd (str): the session's folder.
        paths (Sequence[str]): the absolute paths the command names.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
    """
    left = list(machines)
    if len(left) < 2:
        return left[0] if left else None
    if await registry.policies.wants_for("pre_vfs", session.session_id):
        return left[0]
    for path in (cwd, *paths):
        if len(left) < 2:
            break
        holding = await holding_machines(path, registry)
        left = [m for m in left if m in holding] or left
    return left[0]


async def folder_holders(
    folder: str,
    session: SessionState,
    registry: MountRegistry,
    asked: dict[str, list[str]],
) -> list[str]:
    """The machines holding the folder a command stands in
    (``holding_machines``), asked once a line: ``asked`` keeps each
    folder's answer for every command the line runs
    (``ExecutionFrame.folder_holders``).

    Where a coded file policy speaks for the session no machine is
    asked, since the policy judges a path inside the command that
    opens it: a folder whose mount shows one machine is that
    machine's, and any other is no one machine's.

    Args:
        folder (str): the folder, an absolute virtual path.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        asked (dict[str, list[str]]): the answers the line has had.
    """
    known = asked.get(folder)
    if known is not None:
        return known
    if await registry.policies.wants_for("pre_vfs", session.session_id):
        shown = folder_machines(folder, registry)
        known = shown if len(shown) == 1 else []
    else:
        known = await holding_machines(folder, registry)
    asked[folder] = known
    return known


async def searched_machine(
    name: str,
    paths: Sequence[str],
    session: SessionState,
    registry: MountRegistry,
    routing: RouteDecision[RuntimeIdentity] | None,
    cwd: str | None = None,
    path: str | None = None,
    past_functions: bool = False,
) -> RemoteRuntime | None:
    """The machine a program named by its name runs on when nothing says
    which (``is_searched``): among the machines a run started now would
    find the program on (``finds_program``), the one search order picks
    (``nearest_machine``). A machine that refuses the session's runs is
    asked nothing and is no candidate. None where search
    order does not place the program, and where no machine has it, so
    the first machine answers ``command not found`` as it does today.

    Args:
        name (str): the program's name.
        paths (Sequence[str]): the absolute paths the command names.
        session (SessionState): the session it runs in.
        registry (MountRegistry): the workspace's mounts and machines.
        routing (RouteDecision | None): the line's placement.
        cwd (str | None): the folder it runs from; None for the
            session's own.
        path (str | None): the PATH the command's own prefix sets
            (``PATH=/opt/bin tool``), which its run gets; None for
            the one the session exported.
        past_functions (bool): the program a function of the same
            name shadows is the one asked about (``which``).
    """
    if not is_searched(name, session, registry, routing, past_functions):
        return None
    here = session.cwd if cwd is None else cwd
    on = env_snapshot(session).get("PATH") if path is None else path
    willing = [
        machine
        for machine in searched_machines(registry)
        if not machine.refuses_session()
    ]
    having = await _machines_with(name, on, here, willing)
    picked = await nearest_machine(
        [m.default_machine for m in having],
        here,
        paths,
        session,
        registry,
    )
    return next((m for m in having if m.default_machine == picked), None)


def bound_to(
    routing: RouteDecision[RuntimeIdentity], name: str, runtime: RemoteRuntime
) -> RouteDecision[RuntimeIdentity]:
    """A line's placement with one program bound to the machine search
    order picked for it, for that program's run alone.

    Args:
        routing (RouteDecision): the line's placement.
        name (str): the program's name.
        runtime (RemoteRuntime): the machine that runs it.
    """
    return dataclasses.replace(
        routing, bindings={**routing.bindings, name: runtime}
    )
