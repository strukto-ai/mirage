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

from collections.abc import AsyncGenerator
from contextlib import aclosing

from mirage.io.types import IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import close_stream, open_stream
from mirage.shell.bytes import encode_text


async def printf_output(
    fmt: str,
    args: list[str],
    io: IOResult,
    program: bool = False,
    posix: bool = False,
    utf8: bool = False,
) -> AsyncGenerator[bytes, None]:
    """Format raw shell arguments through the shared bounded engine.

    The output comes out as the engine drains it, one bounded step at a
    time, so a wide field or a long reuse of the format is never held
    whole, and a reader that stops early stops the engine. Each step's
    stderr is added to ``io`` as it comes, after what is there, so an
    output limit's notice stays; the status settles once the output
    ends.

    Args:
        fmt (str): Format text, including shell byte escapes.
        args (list[str]): Raw argument text.
        io (IOResult): where the status and stderr settle.
        program (bool): Use the program's numeric diagnostics.
        posix (bool): Suppress program character-constant warnings.
        utf8 (bool): Read quoted numeric constants as UTF-8 characters.
    """
    stream = open_stream(
        "printf",
        {
            "mode": "program" if program else "builtin",
            "posix": posix,
            "argument_count": len(args),
            "utf8": utf8,
        },
    )
    budget = YieldBudget()
    try:
        for index, text in enumerate([fmt, *args]):
            for at in range(0, len(text), 4096):
                stream.feed_input(index, encode_text(text[at : at + 4096]))
                await budget.run()
            stream.end_input(index)
            await budget.run()
        output = stream.finish()
        _add_stderr(io, stream.take_stderr())
        if output:
            yield output
        while stream.busy():
            output = stream.drain()
            _add_stderr(io, stream.take_stderr())
            if output:
                yield output
            await budget.run()
        io.exit_code = stream.status()
    finally:
        await close_stream(stream)


def _add_stderr(io: IOResult, err: bytes) -> None:
    if err:
        io.stderr = (io.stderr if isinstance(io.stderr, bytes) else b"") + err


async def run_printf(
    fmt: str,
    args: list[str],
    program: bool = False,
    posix: bool = False,
    utf8: bool = False,
) -> tuple[bytes, bytes, int]:
    """``printf_output`` collected whole, for ``printf -v``.

    Args:
        fmt (str): Format text, including shell byte escapes.
        args (list[str]): Raw argument text.
        program (bool): Use the program's numeric diagnostics.
        posix (bool): Suppress program character-constant warnings.
        utf8 (bool): Read quoted numeric constants as UTF-8 characters.
    """
    io = IOResult()
    async with aclosing(
        printf_output(fmt, args, io, program, posix, utf8)
    ) as parts:
        output = b"".join([part async for part in parts])
    stderr = io.stderr if isinstance(io.stderr, bytes) else b""
    return output, stderr, io.exit_code
