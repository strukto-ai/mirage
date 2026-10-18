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
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.cooperative import chunks
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import OpenStream, open_stream
from mirage.types import JsonValue, PathSpec


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


@command("bc", vfs=None, spec=SPECS["bc"])
async def bc(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["bc"])
    config: dict[str, JsonValue] = {
        "math_mode": fl.as_bool("args_l"),
        "line_length": ctx.env.get("BC_LINE_LENGTH") if ctx.env else None,
    }
    source = ctx.stdin if ctx.stdin is not None else b""
    io = IOResult()
    errors: list[bytes] = []

    async def output() -> AsyncGenerator[bytes, None]:
        stream = open_stream("bc", config)
        budget = YieldBudget()
        try:
            async with aclosing(chunks(source)) as bounded:
                async for chunk in bounded:
                    await budget.run()
                    async with aclosing(
                        drained(stream, stream.feed(chunk), io, budget, errors)
                    ) as produced:
                        async for part in produced:
                            yield part
                    if stream.done():
                        break
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
