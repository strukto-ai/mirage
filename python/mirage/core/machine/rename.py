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
from mirage.core.machine.utils import machine_path, run_checked
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


async def rename(
    accessor: MachineAccessor,
    machine: str,
    src: PathSpec,
    dst: PathSpec,
    make_parent: bool,
) -> None:
    """Rename on the source's machine, the destination taken as the new
    name itself, never a directory to move into.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the source's machine.
        src (PathSpec): the source.
        dst (PathSpec): the new name.
        make_parent (bool): make the new name's parent there first, when
            only another machine holds it.
    """
    old = single_quote(machine_path(accessor, src))
    new = machine_path(accessor, dst)
    line = f"mv -T -- {old} {single_quote(new)}"
    if make_parent:
        parent = new.rsplit("/", 1)[0] or "/"
        line = f"mkdir -p -- {single_quote(parent)} && {line}"
    await run_checked(accessor, machine, line, dst)
