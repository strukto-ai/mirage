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
from mirage.core.machine.stat import stat_row
from mirage.errors.fs import einval, enoent
from mirage.types import PathSpec


def stage(accessor: MachineAccessor) -> str | None:
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


async def holders(accessor: MachineAccessor, path: PathSpec) -> list[str]:
    """The machines that hold a name, asked in parallel; a mount on one
    machine asks nothing and lets the op itself report a missing name.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.
    """
    names = accessor.names()
    if len(names) == 1:
        return names
    found = await asyncio.gather(
        *(stat_row(accessor, m, path) for m in names), return_exceptions=True
    )
    held: list[str] = []
    for name, result in zip(names, found):
        if isinstance(result, (FileNotFoundError, NotADirectoryError)):
            continue
        if isinstance(result, BaseException):
            raise result
        held.append(name)
    return held


def chosen(accessor: MachineAccessor, path: PathSpec, held: list[str]) -> str:
    """The one machine of several holding a name that an op on it goes
    to: the only one, else the running program's, else none, since
    picking one would act on a file the command did not mean.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.
        held (list[str]): the machines holding it.
    """
    if len(held) == 1:
        return held[0]
    running = stage(accessor)
    if running is None or running not in held:
        raise einval(path, f"on several machines: {', '.join(held)}")
    return running


async def holder(accessor: MachineAccessor, path: PathSpec) -> str:
    """The machine a read, a removal or a rename of an existing name goes
    to.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name.

    Raises:
        FileNotFoundError: no machine holds it.
        OSError: several hold it and none runs the command's program.
    """
    held = await holders(accessor, path)
    if not held:
        raise enoent(path)
    return chosen(accessor, path, held)


async def lands(accessor: MachineAccessor, path: PathSpec) -> str:
    """The machine a write goes to: the one holding the name, else the
    running program's, else the mount's default.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the name written.
    """
    held = await holders(accessor, path)
    if held:
        return chosen(accessor, path, held)
    return stage(accessor) or accessor.default_machine
