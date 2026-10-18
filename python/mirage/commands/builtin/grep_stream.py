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

from mirage.commands.builtin.grep_binary import (
    PROBE_BLOCK_BYTES,
    GrepFlags,
    group_line,
)
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.errors import UsageError
from mirage.io.stream import close_quietly
from mirage.io.types import IOResult, materialize
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream, open_stream
from mirage.shell.bytes import encode_text
from mirage.types import JsonValue


def latin1(data: bytes) -> str:
    """Bytes as the stream reads them: one character per byte.

    Args:
        data (bytes): the bytes to send.
    """
    return data.decode("latin-1")


def stream_config(
    f: GrepFlags, pattern: str | None, utf8: bool
) -> dict[str, JsonValue]:
    """The mirage-rs grep stream's configuration for a command line.

    Args:
        f (GrepFlags): parsed flags; -P never reaches the stream.
        pattern (str | None): the newline-separated pattern list, None
            for a -f list of no patterns, which matches nothing.
        utf8 (bool): lines are text under a UTF-8 locale.
    """
    patterns = [] if pattern is None else encode_text(pattern).split(b"\n")
    if f.fixed_string:
        syntax = "fixed"
    elif f.syntax is RegexSyntax.EXTENDED:
        syntax = "extended"
    else:
        syntax = "basic"
    separator = group_line(f)
    return {
        "patterns": [latin1(part) for part in patterns],
        "syntax": syntax,
        "ignore_case": f.ignore_case,
        "word": f.whole_word,
        "line": f.line_regexp,
        "utf8": utf8,
        "invert": f.invert,
        "line_numbers": f.line_numbers,
        "byte_offsets": f.byte_offsets,
        "count": f.count_only,
        "files_with_matches": f.files_only,
        "files_without_match": f.files_without_match,
        "quiet": f.quiet,
        "only_matching": f.only_matching,
        "max_count": f.max_count,
        "after": f.after_context or 0,
        "before": f.before_context or 0,
        "binary": f.binary_mode,
        "null_data": f.null_data,
        "null": f.null,
        "initial_tab": f.initial_tab,
        "separator": latin1(separator) if separator else None,
    }


def open_grep(config: dict[str, JsonValue]) -> tuple[OpenStream, bytes]:
    """Compile the pattern list once for the whole command line.

    Args:
        config (dict[str, JsonValue]): from ``stream_config``.

    Returns:
        tuple[OpenStream, bytes]: the stream, and GNU's warnings about
            the patterns as stderr.

    Raises:
        UsageError: a pattern GNU grep refuses, in its wording (exit 2).
    """
    try:
        stream = open_stream("grep", config)
    except StreamRefusal as exc:
        raise UsageError(f"grep: {exc.message}") from exc
    return stream, stream.take_stderr()


async def stream_input(
    source: AsyncIterator[bytes],
    stream: OpenStream,
    path: str,
    show_filename: bool,
    io: IOResult,
    after_output: bool = False,
    size: int | None = None,
) -> AsyncGenerator[bytes, None]:
    """Run one input through the grep stream, yielding grep's output for it.

    Each chunk the backend serves is cut into probe-sized blocks, every one
    a block of the binary-file probe. A back-reference search that needs
    more than one call's steps leaves the stream busy, and the rest runs
    a bounded step per ``drain``, so a timeout or cancellation lands
    between steps.

    Args:
        source (AsyncIterator[bytes]): the input's bytes.
        stream (OpenStream): from ``open_grep``.
        path (str): the name output lines and the notice carry.
        show_filename (bool): whether output lines carry the name.
        io (IOResult): receives the exit status and any notice.
        after_output (bool): an earlier input already printed lines.
        size (int | None): the input's size for -T, None for a pipe.
    """
    budget = YieldBudget()
    stream.begin(
        {
            "label": latin1(encode_text(path)),
            "show_filename": show_filename,
            "size": size,
            "after_output": after_output,
        }
    )
    io.exit_code = 1
    try:
        # -m0 reads nothing.
        if not stream.done():
            async for chunk in source:
                for offset in range(0, len(chunk), PROBE_BLOCK_BYTES):
                    if stream.done():
                        break
                    await budget.run()
                    block = chunk[offset : offset + PROBE_BLOCK_BYTES]
                    async for output in drained(
                        stream, stream.feed(block), io, budget
                    ):
                        yield output
                if stream.done():
                    break
    finally:
        await close_quietly(source)
    async for output in drained(stream, stream.finish(), io, budget):
        yield output


async def drained(
    stream: OpenStream, output: bytes, io: IOResult, budget: YieldBudget
) -> AsyncGenerator[bytes, None]:
    """One call's output, then the rest of its work while it is busy.

    Args:
        stream (OpenStream): the grep stream.
        output (bytes): what the call wrote.
        io (IOResult): the input's result.
        budget (YieldBudget): yields to the event loop between steps.
    """
    while True:
        await settle(stream, io)
        if output:
            yield output
        if not stream.busy():
            return
        await budget.run()
        output = stream.drain()


async def settle(stream: OpenStream, io: IOResult) -> None:
    """Record the input's status and any notice as soon as they change.

    The notice lands at once, so an input whose read later fails, or
    whose reader stops early, still reports it.

    Args:
        stream (OpenStream): the grep stream.
        io (IOResult): the input's result.
    """
    io.exit_code = stream.status()
    if notice := stream.take_stderr():
        io.stderr = (await materialize(io.stderr)) + notice
