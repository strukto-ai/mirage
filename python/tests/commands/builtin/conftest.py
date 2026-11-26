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
from collections.abc import AsyncIterable, AsyncIterator

import pytest

from mirage.io.types import ByteSource, IOResult
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.driver_ops import ops


@pytest.fixture
def backend():
    b = RAMVFS()
    b.accessor.store.dirs.add("/tmp")
    return b


def ram_workspace() -> tuple[Workspace, RAMVFS]:
    """A writable RAM workspace and its backend for shell command tests."""
    mem = RAMVFS()
    ws = Workspace({"/data": (mem, MountMode.WRITE)}, mode=MountMode.WRITE)
    return ws, mem


def run_raw(
    ws: Workspace, cmd: str, cwd: str = "/", stdin: ByteSource | None = None
) -> tuple[ByteSource | None, IOResult]:
    """Run a shell line from a synchronous test, retaining its result.

    Args:
        ws (Workspace): workspace under test.
        cmd (str): shell line.
        cwd (str): working directory for the invocation.
        stdin (ByteSource | None): input supplied to the command.
    """
    ws._cwd = cwd
    io = asyncio.run(ws.shell(cmd, stdin=stdin))
    return io.stdout, io


async def _collect(source: AsyncIterable[bytes]) -> list[bytes]:
    return [chunk async for chunk in source]


def output_bytes(stdout: bytes | AsyncIterable[bytes]) -> bytes:
    """Collect command output from a synchronous test.

    Args:
        stdout (bytes | AsyncIterable[bytes]): bytes or asynchronous output.
    """
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


def file_workspace(**files: bytes) -> Workspace:
    """A writable RAM workspace seeded with mount-relative files.

    Args:
        **files (bytes): initial contents keyed by mount-relative path.
    """
    mem = RAMVFS()
    for path, data in files.items():
        asyncio.run(ops(mem).write(PathSpec.from_str_path(path), data=data))
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


def optional_output_bytes(stdout: ByteSource | None) -> bytes:
    """Collect optional output, rendering absent output as empty bytes.

    Args:
        stdout (ByteSource | None): bytes, asynchronous output, or no output.
    """
    return b"" if stdout is None else output_bytes(stdout)


def stderr_text(io: IOResult) -> str:
    err = io.stderr
    if err is None:
        return ""
    return err.decode() if isinstance(err, bytes) else str(err)


async def split_source(data: bytes, *cuts: int) -> AsyncIterator[bytes]:
    """``data`` as a stream cut at each offset, in order.

    A cut at either end, or two at one offset, yields an empty piece.

    Args:
        data (bytes): the whole input.
        *cuts (int): ascending offsets into ``data``.
    """
    edges = (0, *cuts, len(data))
    for start, end in zip(edges, edges[1:]):
        yield data[start:end]


class TrackedSource:
    """A source that remembers being closed; collection never closes it."""

    def __init__(self, *chunks: bytes) -> None:
        self.chunks = list(chunks)
        self.closed = False

    def __aiter__(self) -> "TrackedSource":
        return self

    async def __anext__(self) -> bytes:
        if not self.chunks:
            raise StopAsyncIteration
        return self.chunks.pop(0)

    async def aclose(self) -> None:
        self.closed = True
