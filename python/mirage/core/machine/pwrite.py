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
from mirage.errors.fs import enotsup
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


async def pwrite(
    accessor: MachineAccessor,
    machine: str,
    path: PathSpec,
    data: bytes,
    offset: int,
) -> None:
    """Write bytes at an offset, as pwrite(2): the rest of the file stays,
    a gap reads back as zeros, a missing file is made. A machine whose
    exec takes no input (Daytona) refuses it.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        path (PathSpec): the file.
        data (bytes): the bytes.
        offset (int): where they start.
    """
    if not accessor.handle(machine).takes_input:
        raise enotsup("machine", "pwrite", path)
    timer = start_op()
    seek = f"seek={offset} oflag=seek_bytes conv=notrunc status=none"
    target = single_quote(machine_path(accessor, path))
    await run_checked(accessor, machine, f"dd of={target} {seek}", path, data)
    record("pwrite", path.virtual, "machine", len(data), timer)
