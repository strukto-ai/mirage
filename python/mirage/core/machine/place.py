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

from mirage.accessor.machine import MachineAccessor
from mirage.context.session_context import current_caller, note_decision
from mirage.core.machine.constants import KERNEL_VIEWS
from mirage.core.machine.stat import hidden_machines, stat_entry
from mirage.core.machine.types import Copies, Holder, Landing
from mirage.core.machine.utils import folder_of, machine_path
from mirage.errors.fs import eacces, enoent, enotdir
from mirage.types import PathSpec, PolicyDecision


def running_machine(accessor: MachineAccessor) -> str | None:
    """The machine the running command's program runs on, when it is one
    of the mount's (``python gen.py > /tmp/out``); None for a command
    that runs no program on one.

    Args:
        accessor (MachineAccessor): the mount's machines.
    """
    machine = current_caller().machine
    if machine is None or machine.name not in accessor.names():
        return None
    return machine.name


def copy_machine(accessor: MachineAccessor) -> str | None:
    """The machine whose file the copy being made by a read and a write
    read (``Caller.copied_from``), when it read one machine's file and
    that machine is one of the mount's; None for any other write.

    Args:
        accessor (MachineAccessor): the mount's machines.
    """
    copied = current_caller().copied_from
    if copied is None or len(copied) != 1:
        return None
    (machine,) = copied
    return machine if machine in accessor.names() else None


def origin_machine(accessor: MachineAccessor) -> str | None:
    """The machine a whole file's bytes come from, which the file lands
    on: the running program's, for its ``>`` (``running_machine``), or
    the source's of a copy made by a read and a write
    (``copy_machine``); None for any other write.

    Args:
        accessor (MachineAccessor): the mount's machines.
    """
    return running_machine(accessor) or copy_machine(accessor)


def note_copy_source(machine: str) -> None:
    """Note a machine whose file the copy being made by a read and a
    write reads (``Caller.copied_from``); nothing outside such a copy.

    Args:
        machine (str): the machine holding the file read.
    """
    copied = current_caller().copied_from
    if copied is not None:
        copied.add(machine)


def crossing_reason(source: str, target: str) -> str:
    """Why bytes from one machine do not go to another, for the decision
    record of the refusal (stderr says ``Permission denied``).

    Args:
        source (str): the machine the bytes come from.
        target (str): the machine they would go to.
    """
    return (
        f"machine {source}'s bytes do not go to machine {target}:"
        " copy them through a store"
    )


def crossing_refused(
    source: str, target: str, path: PathSpec
) -> PermissionError:
    """The refusal of bytes going from one machine to another: EACCES for
    the file, the reason on the line's decision record.

    Args:
        source (str): the machine the bytes come from.
        target (str): the machine they would go to.
        path (PathSpec): the file the refusal names.
    """
    note_decision(
        PolicyDecision(kind="deny", reason=crossing_reason(source, target))
    )
    return eacces(path)


def refuse_crossing(
    accessor: MachineAccessor,
    machine: str,
    path: PathSpec,
    reads: bool = False,
) -> None:
    """Refuse bytes going from one machine to another through a program
    the line runs on a machine: a file of ``machine`` it reads
    (``prog < /srv/b/in``), or its output landing there (``prog >
    /srv/b/out``), when the program is on another of the workspace's
    machines; and a copy made by a read and a write landing on another
    machine than the one whose file it read (``Caller.copied_from``).
    Bytes go between a machine and a store, never from one machine to
    another. The refusal is ``Permission denied``, its reason on the
    line's decision record.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine the op reads from or lands on.
        path (PathSpec): the file.
        reads (bool): the program reads the file, whose bytes go from
            ``machine`` to it; else its bytes land on ``machine``.

    Raises:
        PermissionError: the program runs on another machine.
    """
    caller = current_caller()
    running = caller.machine
    if (
        running is not None
        and running.name != machine
        and accessor.is_machine(running.name)
    ):
        if reads:
            raise crossing_refused(machine, running.name, path)
        raise crossing_refused(running.name, machine, path)
    if reads:
        return
    for source in sorted(caller.copied_from or ()):
        if source != machine and accessor.is_machine(source):
            raise crossing_refused(source, machine, path)


def command_machine(accessor: MachineAccessor) -> str | None:
    """The machine the running command is about, when it is one of the
    mount's: the one its program runs on, else the one a command Mirage
    runs itself prefers (``Caller.preferred_machine``); None when nothing
    says.

    Args:
        accessor (MachineAccessor): the mount's machines.
    """
    running = running_machine(accessor)
    if running is not None:
        return running
    preferred = current_caller().preferred_machine
    return preferred if preferred in accessor.names() else None


def kernel_view_machine(
    accessor: MachineAccessor, path: PathSpec, below: str = ""
) -> str | None:
    """The one machine a name answers for when it is a kernel's own view
    of its machine (``/proc/cpuinfo``), which no rule merges: the machine
    the command is about, else the mount's default. None for any other
    name, and on a mount that shows one machine.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name, or a folder above it.
        below (str): the name's path under ``path``, as a listing of the
            folder gives it; empty for ``path`` itself.
    """
    if not accessor.several:
        return None
    real = machine_path(accessor, path)
    if below:
        real = f"{real.rstrip('/')}/{below}"
    if not any(real == at or real.startswith(at + "/") for at in KERNEL_VIEWS):
        return None
    return command_machine(accessor) or accessor.default_machine


async def asked_machines(
    accessor: MachineAccessor, path: PathSpec
) -> list[str]:
    """The machines asked about a name, in the order ``machines:`` lists
    them: every machine of the mount, less each whose own links lead the
    name to one the session hides, and for a kernel's view of its machine
    only the one it answers for (``kernel_view_machine``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.
    """
    hidden = await hidden_machines(accessor, path)
    own = kernel_view_machine(accessor, path)
    return [
        name
        for name in accessor.names()
        if name not in hidden and own in (None, name)
    ]


async def holders(accessor: MachineAccessor, path: PathSpec) -> list[Holder]:
    """The machines that hold a name, each with its entry there, asked in
    parallel (``asked_machines``); a mount on one machine asks nothing and lets
    the op itself report a missing name.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.
    """
    names = await asked_machines(accessor, path)
    if not accessor.several:
        return [Holder(name) for name in names]
    found = await asyncio.gather(
        *(stat_entry(accessor, m, path) for m in names),
        return_exceptions=True,
    )
    held: list[Holder] = []
    for name, result in zip(names, found):
        if isinstance(result, (FileNotFoundError, NotADirectoryError)):
            continue
        if isinstance(result, BaseException):
            raise result
        held.append(Holder(name, result))
    return held


def chosen(accessor: MachineAccessor, held: list[Holder]) -> Holder:
    """The one of several machines holding a name that every look at it
    goes to: the copy written last, as one machine would hold it, by the
    times the machines report. Copies written at the same time go to the
    machine the command is about, else to the first ``machines:`` lists.

    Args:
        accessor (MachineAccessor): the mount's machines.
        held (list[Holder]): the machines holding the name, at least one.
    """
    if len(held) == 1:
        return held[0]
    last = max(one.written_ms for one in held)
    latest = [one for one in held if one.written_ms == last]
    about = command_machine(accessor)
    return next((one for one in latest if one.machine == about), latest[0])


async def existing_copies(accessor: MachineAccessor, path: PathSpec) -> Copies:
    """Every machine's copy of a name that must exist, each of which a
    removal or a rename reaches, and the one shown (``chosen``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.

    Raises:
        FileNotFoundError: no machine holds it.
    """
    held = await holders(accessor, path)
    if not held:
        raise enoent(path)
    return Copies(tuple(held), chosen(accessor, held))


async def holding_machine(accessor: MachineAccessor, path: PathSpec) -> str:
    """The machine a read of an existing name, or a change to it, goes
    to (``chosen``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.

    Raises:
        FileNotFoundError: no machine holds it.
    """
    return (await existing_copies(accessor, path)).shown.machine


async def refuse_hidden(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> None:
    """Refuse a name a machine's own links lead to one the session
    hides, before a program of the machine's writes through them.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine the write runs on.
        path (PathSpec): the name written.

    Raises:
        FileNotFoundError: the name leads to a hidden one there.
    """
    if machine in await hidden_machines(accessor, path):
        raise enoent(path)


async def _folder_copies(
    accessor: MachineAccessor, folder: PathSpec, path: PathSpec
) -> list[Holder]:
    """The machines holding a folder as a folder, for a name made in it.

    Args:
        accessor (MachineAccessor): the mount's machines.
        folder (PathSpec): the folder.
        path (PathSpec): the name made in it, which a refusal names.

    Raises:
        NotADirectoryError: the copy shown of the folder is a file,
            whatever an older folder on another machine is.
    """
    held = await holders(accessor, folder)
    if held and not chosen(accessor, held).is_folder:
        raise enotdir(path)
    return [one for one in held if one.is_folder]


async def machines_lacking_folder(
    accessor: MachineAccessor, machines: list[str], path: PathSpec
) -> list[str]:
    """The machines a new name lands on that must make its folder first,
    since only other machines hold it; none where no machine holds the
    folder, whose lack the op reports.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machines (list[str]): the machines the name lands on.
        path (PathSpec): the new name.

    Raises:
        NotADirectoryError: the copy shown of the folder is a file,
            whatever an older folder on another machine is.
    """
    if not accessor.several:
        return []
    folders = [
        one.machine
        for one in await _folder_copies(accessor, folder_of(path), path)
    ]
    return [m for m in machines if folders and m not in folders]


async def _lacks_folder(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> bool:
    """Whether a new name landing on a machine must make its folder there
    first (``machines_lacking_folder``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine the name lands on.
        path (PathSpec): the new name.

    Raises:
        NotADirectoryError: the copy shown of the folder is a file.
    """
    return bool(await machines_lacking_folder(accessor, [machine], path))


async def new_name_machine(
    accessor: MachineAccessor, path: PathSpec, parents: bool = False
) -> str:
    """The machine a new name lands on: the one the command is about,
    else the mount's default, when it holds the name's folder or no
    machine does; else the machine that holds the folder (``chosen``), so
    a name made in a folder is listed with the folder's other names. A
    mount on one machine asks nothing: the name lands there.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the new name.
        parents (bool): the folders above are made too (``mkdir -p``),
            so the folder is the nearest one above that any machine
            holds.

    Raises:
        NotADirectoryError: the copy shown of the folder is a file,
            whatever an older copy on another machine is.
    """
    about = command_machine(accessor) or accessor.default_machine
    if not accessor.several:
        return about
    above = folder_of(path)
    while True:
        folders = await _folder_copies(accessor, above, path)
        if folders or not parents or not above.vfs_path:
            break
        above = folder_of(above)
    if not folders or about in [one.machine for one in folders]:
        return about
    return chosen(accessor, folders).machine


async def write_machine(
    accessor: MachineAccessor,
    path: PathSpec,
    *,
    replaces: bool = False,
    parents: bool = False,
) -> str:
    """The machine a write goes to. What a program's ``>`` replaces lands
    on the program's machine, whose disk the program reads next, and a
    copy made by a read and a write on its source's (``origin_machine``).
    Any other write of a name some machine holds goes to that copy
    (``chosen``), and a new name goes where its folder is
    (``new_name_machine``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name written.
        replaces (bool): the write replaces the whole file.
        parents (bool): the folders above a new name are made too.

    Raises:
        FileNotFoundError: the machine's own links lead the name to one
            the session hides.
    """
    origin = origin_machine(accessor) if replaces else None
    if origin is None:
        held = await holders(accessor, path)
        if held:
            return chosen(accessor, held).machine
    target = origin or await new_name_machine(accessor, path, parents)
    await refuse_hidden(accessor, target, path)
    return target


async def landing(
    accessor: MachineAccessor,
    path: PathSpec,
    *,
    replaces: bool = False,
) -> Landing:
    """Where a write of a name lands (``write_machine``), refusing bytes a
    program or a copy brings from another machine (``refuse_crossing``).
    A whole file whose bytes come from the machine it lands on
    (``origin_machine``) replaces the name across the machines, and its
    folder is made there when only another machine holds it.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name written.
        replaces (bool): the write replaces the whole file.

    Raises:
        PermissionError: the bytes come from another machine.
        FileNotFoundError: the machine's own links lead the name to one
            the session hides.
        NotADirectoryError: the copy shown of the name's folder is a file.
    """
    machine = await write_machine(accessor, path, replaces=replaces)
    refuse_crossing(accessor, machine, path)
    if not replaces or origin_machine(accessor) != machine:
        return Landing(machine)
    return Landing(
        machine,
        origin=True,
        make_parent=await _lacks_folder(accessor, machine, path),
    )


async def landing_on(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> Landing:
    """A copy's landing on the machine its source is on, which the copy
    never leaves: refused where the machine's own links lead the name to
    a hidden one, its folder made there when only another machine holds
    it.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the source's machine.
        path (PathSpec): the copy's name.

    Raises:
        FileNotFoundError: the name leads to a hidden one there.
        NotADirectoryError: the copy shown of the name's folder is a file.
    """
    await refuse_hidden(accessor, machine, path)
    return Landing(
        machine,
        origin=True,
        make_parent=await _lacks_folder(accessor, machine, path),
    )
