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
from mirage.core.machine.utils import checked, remote
from mirage.core.posix.constants import COPIED
from mirage.core.posix.copy import copy_tree_command
from mirage.core.posix.errors import refusal
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


def _in_folder(line: str, target: str, make_parent: bool) -> str:
    """A copy's line, the new name's folder made first when asked.

    Args:
        line (str): the copy.
        target (str): the new name's path on the machine.
        make_parent (bool): make its folder there first.
    """
    if not make_parent:
        return line
    parent = target.rsplit("/", 1)[0] or "/"
    return f"mkdir -p -- {single_quote(parent)} && {line}"


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
    old = single_quote(remote(accessor, src))
    new = remote(accessor, dst)
    line = _in_folder(f"cp -T -- {old} {single_quote(new)}", new, make_parent)
    await checked(accessor, machine, line, dst)


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
    new = remote(accessor, dst)
    line = _in_folder(
        copy_tree_command(remote(accessor, src), new), new, make_parent
    )
    status, out, err = await accessor.run(machine, line)
    if status != 0 or out != COPIED:
        raise refusal(dst, err)
