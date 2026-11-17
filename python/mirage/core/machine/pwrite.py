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
from mirage.core.machine.write import rewrite
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
    a gap reads back as zeros, a missing file is made.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        path (PathSpec): the file.
        data (bytes): the bytes.
        offset (int): where they start.
    """
    timer = start_op()
    if accessor.handle(machine).takes_input:
        target = single_quote(remote(accessor, path))
        command = (
            f"dd of={target} seek={offset} oflag=seek_bytes conv=notrunc "
            "status=none"
        )
        await checked(accessor, machine, command, path, data)
    else:
        await rewrite(
            accessor,
            machine,
            path,
            lambda old: (
                old[:offset].ljust(offset, b"\0")
                + data
                + old[offset + len(data) :]
            ),
        )
    record("pwrite", path.virtual, "machine", len(data), timer)
