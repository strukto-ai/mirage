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
from collections.abc import AsyncIterator

from mirage.commands.builtin.generic.crossmount.constants import (
    LINE_STREAM_COMMANDS,
)
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    CrossResult,
    RunSingle,
)
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_code_from_line
from mirage.concurrency.limiter import settle
from mirage.errors.render import revoice_fs_error_line
from mirage.io import IOResult
from mirage.io.stdio import OutputStream
from mirage.io.stream import async_chain, close_quietly, drain, materialize
from mirage.io.types import ByteSource, OutputState
from mirage.types import PathSpec


def _has_active_flags(flag_kwargs: dict[str, FlagValue]) -> bool:
    return any(v not in (None, False) for v in flag_kwargs.values())


async def _line_ended(source: ByteSource) -> AsyncIterator[bytes]:
    """One operand's bytes, its last line ended where the file ends.

    What a line reader sees at a file boundary: ``ab`` followed by the
    next file's ``cd`` is two lines, the way the single-mount commands
    join their operands.

    Args:
        source (ByteSource): the operand's bytes.
    """
    last = b"\n"
    async for chunk in async_chain([source]):
        if chunk:
            last = chunk[-1:]
        yield chunk
    if last != b"\n":
        yield b"\n"


def _respell_fetch_stderr(
    stderr: bytes, cmd_name: str, scope: PathSpec
) -> bytes:
    # The per-operand fetch is a native Cmd.CAT sub-run, so its error lines
    # carry the fetch command's voice; each is said again in the real
    # command's (its prefix, its quoting, the step it names) so the
    # cross-mount bytes match single-mount.
    text = stderr.decode("utf-8", "surrogateescape")
    return "\n".join(
        revoice_fs_error_line(line, Cmd.CAT, cmd_name, scope)
        for line in text.split("\n")
    ).encode("utf-8", "surrogateescape")


async def run_stream(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict[str, FlagValue],
    run_single: RunSingle,
) -> CrossResult:
    """Run a stream command (``cmd files...`` == ``cat files... | cmd``).

    Each operand's raw bytes come from a native flagless ``cat`` on its
    owning mount (which also expands the operand's glob natively); one
    native run of the real command then consumes the merged stream in its
    stdin mode, so every flag keeps its single-invocation semantics
    (continuous ``cat -n``/``nl`` numbering, one global ``sort`` order, one
    ``sed`` address space). A failed operand is skipped and reported on
    stderr, cat-style; the merged exit code is then non-zero.

    Args:
        cmd_name (str): One of the STREAM_COMMANDS.
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (sed script).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        run_single (RunSingle): Executor-injected single-mount runner.
    """
    result = IOResult()
    state = OutputState()
    result.output = state
    fetches: list[tuple[PathSpec, ByteSource | None, IOResult]] = []
    sources: list[ByteSource] = []

    async def finish(final: IOResult | None = None) -> None:
        merged = IOResult()
        fail_code = 0
        for scope, _, io in fetches:
            if io.exit_code != 0:
                rendered = await materialize(io.stderr)
                if cmd_name != Cmd.CAT:
                    rendered = _respell_fetch_stderr(rendered, cmd_name, scope)
                io.stderr = rendered
                fail_code = max(
                    fail_code,
                    read_fail_exit_code_from_line(cmd_name, rendered),
                    1,
                )
                io.exit_code = 0
            merged = await merged.merge(io)
        if final is not None:
            merged = await merged.merge(final)
        result.reads = merged.reads
        result.writes = merged.writes
        result.cache = merged.cache
        result.renames = merged.renames
        result.matched_runs = merged.matched_runs
        result.sized_runs = merged.sized_runs
        result.counted_runs = merged.counted_runs
        result.refusal = result.refusal or merged.refusal
        result.stderr = (
            await materialize(merged.stderr) + await materialize(result.stderr)
        ) or None
        result.exit_code = result.exit_code or merged.exit_code or fail_code
        state.finish()

    async def close_fetches() -> None:
        await asyncio.gather(*(close_quietly(out) for _, out, _ in fetches))

    try:
        for scope in scopes:
            out, io = await run_single(Cmd.CAT, [scope], [], {})
            fetches.append((scope, out, io))
            result.producer = io.producer
            result.refusal = io.refusal or result.refusal
            if io.exit_code != 0:
                await drain(out)
            elif out is not None:
                sources.append(out)
        if cmd_name == Cmd.SORT and any(
            io.exit_code != 0 for _, _, io in fetches
        ):
            await close_fetches()
            await finish()
            return None, result

        if cmd_name in LINE_STREAM_COMMANDS and sources:
            ended: list[ByteSource] = [_line_ended(s) for s in sources[:-1]]
            sources = ended + sources[-1:]
        body: ByteSource = async_chain(sources)
        final: IOResult | None = None
        if cmd_name == Cmd.CAT and not _has_active_flags(flag_kwargs):
            out = body
        else:
            out, final = await run_single(
                cmd_name,
                [],
                list(text_args),
                flag_kwargs,
                stdin=body,
                resolve_hint=scopes[0],
            )
            result.producer = final.producer
            result.refusal = final.refusal or result.refusal
    except BaseException:
        await close_fetches()
        raise

    closing: asyncio.Task[None] | None = None

    async def finalize() -> None:
        await asyncio.gather(close_quietly(out), close_fetches())
        await finish(final)

    async def close() -> None:
        nonlocal closing
        if closing is None:
            closing = asyncio.create_task(finalize())
        await settle(closing)

    async def output() -> AsyncIterator[bytes]:
        try:
            async for data in async_chain([out] if out is not None else []):
                if cmd_name != Cmd.SORT or not any(
                    io.exit_code != 0 for _, _, io in fetches
                ):
                    yield data
        finally:
            await close()

    return OutputStream(output(), close), result
