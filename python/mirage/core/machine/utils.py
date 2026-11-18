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
from mirage.utils.path import norm


def remote(accessor: MachineAccessor, path: PathSpec) -> str:
    """A mount path's path on the machines.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): the path on the mount.
    """
    return join_root(accessor.root, path.mount_path)


def mount_base(path: PathSpec) -> str:
    """The virtual path of the mount root ``path`` is under.

    Args:
        path (PathSpec): a path on the mount.
    """
    virtual = path.virtual.rstrip("/")
    return norm(virtual[: len(virtual) - len(path.vfs_path)] or "/")


def virtual_of(
    accessor: MachineAccessor, path: PathSpec, real: str
) -> str | None:
    """The virtual name a path on the machines has on the mount ``path``
    is on; None for one outside the mount's root.

    Args:
        accessor (MachineAccessor): the mount's machines.
        path (PathSpec): a path on the mount.
        real (str): an absolute path on the machines.
    """
    root = accessor.root.rstrip("/")
    if root and real != root and not real.startswith(root + "/"):
        return None
    return norm(f"{mount_base(path)}/{real[len(root) :].lstrip('/')}")


async def checked(
    accessor: MachineAccessor,
    machine: str,
    command: str,
    path: PathSpec,
    stdin: ByteSource | None = None,
    *,
    bounded: bool = False,
) -> bytes:
    """Run one line on a machine and return its output; a line that
    fails raises the error its first complaint names.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        command (str): the line.
        path (PathSpec): the path a failure names.
        stdin (ByteSource | None): the bytes fed to the line.
        bounded (bool): hold its output to the workspace's memory room,
            for a line that reads a file's content.
    """
    status, out, err = await accessor.run(
        machine, command, stdin, bounded=bounded
    )
    if status != 0 or err:
        raise refusal(path, err)
    return out
