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

from collections.abc import AsyncIterator
from uuid import uuid4

from mirage.accessor.machine import MachineAccessor
from mirage.core.machine.utils import checked, remote
from mirage.errors.fs import enotsup
from mirage.io.cooperative import chunks
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.quote import single_quote


def write_command(target: str, append: bool, atomic: bool) -> str:
    """The line that writes what it is fed to a file: in place, at its
    end, or onto a sibling name renamed over it once the input ends, so
    nothing shows a half-written file and nothing is left behind.

    Args:
        target (str): the file's path on the machine.
        append (bool): add to the end instead of replacing.
        atomic (bool): show nothing until the input has ended whole.
    """
    q = single_quote(target)
    if append:
        return f"cat >> {q}"
    if not atomic:
        return f"cat > {q}"
    staged = single_quote(f"{target}.mirage-{uuid4().hex}")
    return (
        f"cat > {staged} && mv -f -- {staged} {q}"
        f" || {{ rm -f -- {staged}; exit 1; }}"
    )


async def write(
    accessor: MachineAccessor,
    machine: str,
    path: PathSpec,
    data: ByteSource,
    append: bool = False,
    atomic: bool = False,
) -> None:
    """Write a file on a machine, the bytes streamed to its ``cat``. A
    machine whose exec takes no input (Daytona) refuses the write.

    Args:
        accessor (MachineAccessor): the mount's machines.
        machine (str): the machine's name.
        path (PathSpec): the file.
        data (ByteSource): the bytes, consumed once.
        append (bool): add them to the end instead.
        atomic (bool): show nothing until the stream has ended whole.
    """
    if not accessor.handle(machine).takes_input:
        await close_quietly(data)
        raise enotsup("machine", "append" if append else "write", path)
    timer = start_op()
    size = 0

    async def counted() -> AsyncIterator[bytes]:
        nonlocal size
        async for part in chunks(data):
            size += len(part)
            yield part

    try:
        command = write_command(remote(accessor, path), append, atomic)
        await checked(accessor, machine, command, path, counted())
    finally:
        await close_quietly(data)
    record(
        "append" if append else "write", path.virtual, "machine", size, timer
    )
