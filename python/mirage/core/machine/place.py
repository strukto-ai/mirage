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
from mirage.context.session_context import current_caller
from mirage.core.machine.constants import KERNEL_VIEWS
from mirage.core.machine.stat import hidden_on, stat_entry
from mirage.core.machine.types import Holder
from mirage.core.machine.utils import folder_of, remote
from mirage.errors.fs import enoent, enotdir
from mirage.types import PathSpec


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


def kernel_view(
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
    real = remote(accessor, path)
    if below:
        real = f"{real.rstrip('/')}/{below}"
    if not any(real == at or real.startswith(at + "/") for at in KERNEL_VIEWS):
        return None
    return command_machine(accessor) or accessor.default_machine


async def asked(accessor: MachineAccessor, path: PathSpec) -> list[str]:
    """The machines asked about a name, in the order ``machines:`` lists
    them: every machine of the mount, less each whose own links lead the
    name to one the session hides, and for a kernel's view of its machine
    only the one it answers for (``kernel_view``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.
    """
    hidden = await hidden_on(accessor, path)
    own = kernel_view(accessor, path)
    return [
        name
        for name in accessor.names()
        if name not in hidden and own in (None, name)
    ]


async def holders(accessor: MachineAccessor, path: PathSpec) -> list[Holder]:
    """The machines that hold a name, each with its entry there, asked in
    parallel (``asked``); a mount on one machine asks nothing and lets
    the op itself report a missing name.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.
    """
    names = await asked(accessor, path)
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
    last = max(one.written for one in held)
    latest = [one for one in held if one.written == last]
    about = command_machine(accessor)
    return next((one for one in latest if one.machine == about), latest[0])


async def holder(accessor: MachineAccessor, path: PathSpec) -> str:
    """The machine a read of an existing name, or a change to it, goes
    to (``chosen``).

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.

    Raises:
        FileNotFoundError: no machine holds it.
    """
    held = await holders(accessor, path)
    if not held:
        raise enoent(path)
    return chosen(accessor, held).machine


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
        held = await holders(accessor, above)
        if held and not chosen(accessor, held).folder:
            raise enotdir(path)
        folders = [one for one in held if one.folder]
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
    on the program's machine, whose disk the program reads next. Any
    other write of a name some machine holds goes to that copy
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
    running = running_machine(accessor) if replaces else None
    if running is None:
        held = await holders(accessor, path)
        if held:
            return chosen(accessor, held).machine
    target = running or await new_name_machine(accessor, path, parents)
    if target in await hidden_on(accessor, path):
        raise enoent(path)
    return target
