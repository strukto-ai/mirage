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

from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from functools import partial

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.io.cooperative import chunks
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import OpenStream, open_stream
from mirage.shell.bytes import encode_text
from mirage.types import FileType, JsonValue, PathSpec


class Diagnostics(AsyncIterator[bytes]):
    """The diagnostics so far.

    Each pass starts its own cursor, so concurrent readers each read all
    of them.

    Args:
        parts (list[bytes]): the invocation's diagnostic chunks, shared.
        count (int): how many of them this snapshot holds.
    """

    def __init__(self, parts: list[bytes], count: int) -> None:
        self._parts = parts
        self._count = count
        self._read = 0

    def __aiter__(self) -> "Diagnostics":
        return Diagnostics(self._parts, self._count)

    async def __anext__(self) -> bytes:
        if self._read == self._count:
            raise StopAsyncIteration
        self._read += 1
        return self._parts[self._read - 1]


async def drained(
    stream: OpenStream,
    output: bytes,
    io: IOResult,
    budget: YieldBudget,
    errors: list[bytes],
) -> AsyncGenerator[bytes, None]:
    """Collect diagnostics before yielding output and drain pending work.

    Args:
        stream (OpenStream): the invocation's evaluator.
        output (bytes): the last call's output.
        io (IOResult): receives status and diagnostics immediately.
        budget (YieldBudget): schedules cancellation between Rust calls.
        errors (list[bytes]): retains diagnostic chunks for snapshots.
    """
    while True:
        io.exit_code = stream.status()
        if notice := stream.take_stderr():
            errors.append(notice)
            io.stderr = Diagnostics(errors, len(errors))
        if output:
            yield output
        if not stream.busy():
            return
        await budget.run()
        output = stream.drain()


async def read_file(path: PathSpec, ctx: Context) -> tuple[bytes, str | None]:
    """One operand bc runs ahead of standard input, or what it says when it
    cannot read it.

    Args:
        path (PathSpec): the file operand.
        ctx (Context): the invocation, whose files hold it.

    Returns:
        tuple[bytes, str | None]: the file's bytes, and the diagnostic that
        stops bc if it could not read them.
    """
    unreadable = f"{path.raw_path} 1: read() in flex scanner failed\n"
    try:
        if ctx.vfs is None:
            raise FileNotFoundError(path.raw_path)
        # bc opens a directory and fails reading it; asked first, since a
        # store may answer a directory's read as missing, or with bytes.
        if (await ctx.vfs.stat(path)).type == FileType.DIRECTORY:
            return b"", unreadable
        return await ctx.vfs.read(path), None
    except IsADirectoryError:
        return b"", unreadable
    except FS_ERRORS:
        return b"", f"File {path.raw_path} is unavailable.\n"


async def expanded(paths: list[PathSpec], ctx: Context) -> list[PathSpec]:
    """bc's file operands with their globs expanded, as the shell would
    have; a word that matches nothing stays as typed, and bc cannot open
    it.

    Args:
        paths (list[PathSpec]): the file operands.
        ctx (Context): the invocation, whose files hold them.
    """
    if ctx.vfs is None or all(path.resolved for path in paths):
        return paths
    return await command_files(ctx, paths).resolve_glob(paths)


@command("bc", vfs=None, spec=SPECS["bc"])
async def bc(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["bc"])
    config: dict[str, JsonValue] = {
        "math_mode": fl.as_bool("mathlib"),
        "line_length": ctx.env.get("BC_LINE_LENGTH") if ctx.env else None,
    }
    source = ctx.stdin if ctx.stdin is not None else b""
    io = IOResult()
    errors: list[bytes] = []

    async def output() -> AsyncGenerator[bytes, None]:
        # GNU bc runs the files in order, then standard input, as one
        # program. It opens a file once the ones before it have run, so quit
        # or halt leaves the rest unread, and a file it cannot read ends the
        # run there, exit 1.
        operands = await expanded(paths, ctx)
        # A name is bytes, which travel one character each.
        config["files"] = [
            encode_text(path.raw_path).decode("latin-1") for path in operands
        ]
        stream = open_stream("bc", config)
        budget = YieldBudget()

        async def fed(piece: ByteSource) -> AsyncGenerator[bytes, None]:
            async with aclosing(chunks(piece)) as bounded:
                async for chunk in bounded:
                    await budget.run()
                    async with aclosing(
                        drained(stream, stream.feed(chunk), io, budget, errors)
                    ) as produced:
                        async for part in produced:
                            yield part
                    if stream.done():
                        return

        refusal: str | None = None
        try:
            for index, path in enumerate(operands):
                if stream.done():
                    break
                data, refusal = await read_file(path, ctx)
                if refusal is not None:
                    break
                async with aclosing(fed(data)) as produced:
                    async for part in produced:
                        yield part
                async with aclosing(
                    drained(
                        stream, stream.end_input(index), io, budget, errors
                    )
                ) as produced:
                    async for part in produced:
                        yield part
            if refusal is not None:
                # bc stops at the file it cannot open: a statement or
                # comment the files before it left open never runs.
                errors.append(encode_text(refusal))
                io.stderr = Diagnostics(errors, len(errors))
                io.exit_code = 1
                return
            if not stream.done():
                async with aclosing(fed(source)) as produced:
                    async for part in produced:
                        yield part
            async with aclosing(
                drained(stream, stream.finish(), io, budget, errors)
            ) as produced:
                async for part in produced:
                    yield part
        finally:
            # Snapshots serve reads while output drains; once it stops, the
            # command record copies stderr only as bytes, so join it once.
            if errors:
                io.stderr = b"".join(errors)

    return OutputStream(output(), partial(close_quietly, source)), io
