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

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine.utils import in_folder, machine_path, run_checked
from mirage.core.posix.constants import COPIED
from mirage.core.posix.copy import copy_tree_command
from mirage.core.posix.errors import refusal
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


async def copy(
    accessor: MachineAccessor,
    machine: str,
    src: PathSpec,
    dst: PathSpec,
    make_parent: bool = False,
) -> None:
    """Copy a file on the source's machine.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the source's machine.
        src (PathSpec): the source.
        dst (PathSpec): the copy.
        make_parent (bool): make the copy's folder there first, when
            only another machine holds it.
    """
    await copy_from(accessor, accessor, machine, src, dst, make_parent)


async def copy_from(
    source: MachineAccessor,
    accessor: MachineAccessor,
    machine: str,
    src: PathSpec,
    dst: PathSpec,
    make_parent: bool = False,
) -> None:
    """Copy a file another machine mount shows onto this one, on the
    machine holding it, which both mounts show: the bytes stay there.

    Args:
        source (MachineAccessor): the source mount's machines.
        accessor (MachineAccessor): this mount's machines.
        machine (str): the source's machine.
        src (PathSpec): the source, on its mount.
        dst (PathSpec): the copy, on this mount.
        make_parent (bool): make the copy's folder there first, when
            only another machine holds it.
    """
    old = single_quote(machine_path(source, src))
    new = machine_path(accessor, dst)
    line = in_folder(f"cp -T -- {old} {single_quote(new)}", new, make_parent)
    await run_checked(accessor, machine, line, dst)


async def dir_copy(
    accessor: MachineAccessor,
    machine: str,
    src: PathSpec,
    dst: PathSpec,
    make_parent: bool = False,
) -> None:
    """Copy a directory tree onto a fresh name on the source's machine.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the source's machine.
        src (PathSpec): the directory.
        dst (PathSpec): the copy.
        make_parent (bool): make the copy's folder there first, when
            only another machine holds it.
    """
    new = machine_path(accessor, dst)
    line = in_folder(
        copy_tree_command(machine_path(accessor, src), new), new, make_parent
    )
    status, out, err = await accessor.run(machine, line)
    if status != 0 or out != COPIED:
        raise refusal(dst, err)
