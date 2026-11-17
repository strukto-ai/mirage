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
from mirage.core.posix.errors import refusal
from mirage.core.posix.utils import join_root
from mirage.io.types import ByteSource
from mirage.types import PathSpec


def remote(accessor: MachineAccessor, path: PathSpec) -> str:
    """A mount path's path on the machines.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the path on the mount.
    """
    return join_root(accessor.root, path.mount_path)


async def checked(
    accessor: MachineAccessor,
    machine: str,
    command: str,
    path: PathSpec,
    stdin: ByteSource | None = None,
) -> bytes:
    """Run one line on a machine and return its output; a line that
    fails raises the error its first complaint names.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        command (str): the line.
        path (PathSpec): the path a failure names.
        stdin (ByteSource | None): the bytes fed to the line.
    """
    status, out, err = await accessor.run(machine, command, stdin)
    if status != 0 or err:
        raise refusal(path, err)
    return out
