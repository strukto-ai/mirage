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
from mirage.core.posix.read import line_count as posix_line_count
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


def read_command(target: str, offset: int, size: int | None) -> str:
    """The line that prints a file's bytes from ``offset``, ``size`` of
    them or all.

    Args:
        target (str): the file's path on the machine.
        offset (int): the first byte.
        size (int | None): how many bytes; None for the rest.
    """
    q = single_quote(target)
    if offset and size is not None:
        return f"tail -c +{offset + 1} -- {q} | head -c {size}"
    if offset:
        return f"tail -c +{offset + 1} -- {q}"
    if size is not None:
        return f"head -c {size} -- {q}"
    return f"cat -- {q}"


async def read(
    accessor: MachineAccessor,
    machine: str,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    timer = start_op()
    data = await checked(
        accessor,
        machine,
        read_command(remote(accessor, path), offset, size),
        path,
        bounded=True,
    )
    record("read", path.virtual, "machine", len(data), timer)
    return data


async def first_lines(
    accessor: MachineAccessor, machine: str, path: PathSpec, n: int
) -> bytes:
    target = single_quote(remote(accessor, path))
    return await checked(
        accessor, machine, f"head -n {n} -- {target}", path, bounded=True
    )


async def last_lines(
    accessor: MachineAccessor, machine: str, path: PathSpec, n: int
) -> bytes:
    target = single_quote(remote(accessor, path))
    return await checked(
        accessor, machine, f"tail -n {n} -- {target}", path, bounded=True
    )


async def line_count(
    accessor: MachineAccessor, machine: str, path: PathSpec
) -> int | None:
    return await posix_line_count(
        accessor.runner(machine), remote(accessor, path)
    )
