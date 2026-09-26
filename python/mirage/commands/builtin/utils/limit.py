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
import logging
import time
from collections.abc import AsyncIterator

from mirage.commands.errors import CommandTimeoutError, LimitExceededError
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import Limit, OnExceed
from mirage.utils.stream import ensure_stream

logger = logging.getLogger(__name__)


async def with_timeout(
    src: ByteSource,
    seconds: float,
    command: str,
) -> AsyncIterator[bytes]:
    stream = ensure_stream(src)
    start = time.monotonic()
    iterator = stream.__aiter__()
    while True:
        remaining = seconds - (time.monotonic() - start)
        if remaining <= 0:
            raise CommandTimeoutError(command, seconds)
        try:
            chunk = await asyncio.wait_for(iterator.__anext__(),
                                           timeout=remaining)
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError as exc:
            raise CommandTimeoutError(command, seconds) from exc
        yield chunk


def maybe_with_timeout(
    stream: ByteSource | None,
    limit: Limit | None,
    command: str,
) -> ByteSource | None:
    """Wrap a byte stream with a timeout if the limit calls for one.

    Returns the stream untouched when it is None, already bytes, or the
    limit has no positive timeout. Single source of the wrap rule
    shared by stdout, stderr, and any other stream channel.

    Args:
        stream (ByteSource | None): the stream to maybe wrap.
        limit (Limit | None): resolved limit.
        command (str): command name for the timeout message.
    """
    if stream is None or isinstance(stream, bytes):
        return stream
    if limit is None or not limit.timeout_seconds:
        return stream
    if limit.timeout_seconds <= 0:
        return stream
    return with_timeout(stream, limit.timeout_seconds, command)


async def run_with_timeout(coro, seconds: float | None, name: str):
    """Wrap a coroutine with a deadline, mapping overrun to a timeout error.

    Used by eager builtins, dry-run, and VFS ops. Returns the coroutine
    result unchanged when seconds is falsy or non-positive.

    Args:
        coro: the awaitable to run.
        seconds (float | None): timeout budget, or None to disable.
        name (str): command/op name for the timeout message.
    """
    if not seconds or seconds <= 0:
        return await coro
    try:
        return await asyncio.wait_for(coro, timeout=seconds)
    except asyncio.TimeoutError as exc:
        raise CommandTimeoutError(name or "?", seconds) from exc


def row_cap_notice(command: str, operand: str, count: int, unit: str,
                   knob: str) -> bytes:
    """What a row-pushing command says when a mount's ceiling cut it short.

    ``head -n`` / ``tail -n`` on a database mount push the count into
    the query, and the mount caps how many rows one read may return. A
    count past the ceiling used to be clamped to it in silence, printing
    fewer lines than GNU would with exit 0; the rows up to the ceiling
    are still printed, but this notice goes to stderr and the command
    exits 1, as ``du`` does when its walk stops early.

    Args:
        command (str): the command name, which leads the line.
        operand (str): the operand as the line spelled it.
        count (int): how many were printed.
        unit (str): what was counted (``rows``, ``documents``).
        knob (str): the config field that set the ceiling.

    Returns:
        bytes: one newline-terminated line.
    """
    return (f"{command}: {operand}: stopped at {count} {unit} ({knob}); "
            "the output is incomplete\n").encode()


async def note_after(src: ByteSource, io: IOResult,
                     notices: list[bytes]) -> AsyncIterator[bytes]:
    """Stream ``src``, then append whatever ``notices`` gathered to ``io``.

    The rows a pushed-down read returns are only counted once the read
    has run, which is while the command's output streams, so the notice
    and the failing status land on ``io`` after the stream drains, the
    way ``truncate_stream`` settles an output cap.

    Args:
        src (ByteSource): the command's output.
        io (IOResult): the command's result, updated in place.
        notices (list[bytes]): filled by the reads while ``src`` drains.
    """
    async for chunk in ensure_stream(src):
        yield chunk
    if notices:
        existing = (await materialize(io.stderr)
                    if io.stderr is not None else b"")
        io.stderr = existing + b"".join(notices)
        io.exit_code = 1


def _build_notice(limit: Limit) -> bytes:
    parts: list[str] = []
    if limit.max_lines is not None:
        parts.append(f"{limit.max_lines} lines")
    if limit.max_bytes is not None:
        parts.append(f"{limit.max_bytes} bytes")
    detail = " / ".join(parts)
    return (f"output truncated at limit ({detail}); "
            "narrow the selection or raise command_limits for this command\n"
            ).encode()


async def _bounded_stream(src: ByteSource,
                          io: IOResult,
                          limit: Limit,
                          command: str = "") -> AsyncIterator[bytes]:
    total = lines = 0
    src_stream = ensure_stream(src)
    try:
        async for chunk in src_stream:
            end = len(chunk)
            if limit.max_bytes is not None:
                end = min(end, max(0, limit.max_bytes - total))
            if limit.max_lines is not None:
                remaining = limit.max_lines - lines
                if remaining <= 0:
                    end = 0
                else:
                    at = 0
                    for _ in range(remaining):
                        newline = chunk.find(b"\n", at, end)
                        if newline < 0:
                            break
                        at = newline + 1
                    else:
                        end = at
            kept = chunk[:end]
            total += end
            lines += kept.count(b"\n")
            if kept:
                yield kept
            if end < len(chunk):
                prefix = f"{command}: ".encode() if command else b""
                io.stderr = await materialize(io.stderr
                                              ) + prefix + _build_notice(limit)
                if limit.on_exceed is OnExceed.ERROR:
                    io.exit_code = 1
                return
    finally:
        await close_quietly(src_stream)
        await close_quietly(src)


async def apply_limit(
        src: ByteSource,
        limit: Limit | None) -> tuple[ByteSource | None, IOResult]:
    io = IOResult()
    if limit is None or (limit.max_lines is None and limit.max_bytes is None):
        return src, io
    data = await materialize(_bounded_stream(src, io, limit))
    return (None if io.exit_code else data), io


async def truncate_stream(
    src: ByteSource,
    io: IOResult,
    limit: Limit,
) -> AsyncIterator[bytes]:
    """Lazily truncate a byte stream and attach the outcome to ``io``.

    Unlike :func:`apply_limit`, this never gathers the stream. Sources that
    may be endless use it before any VALUE barrier can materialize them.
    """
    max_bytes = limit.max_bytes
    if max_bytes is None:
        async for chunk in ensure_stream(src):
            yield chunk
        return

    emitted = 0
    async for chunk in ensure_stream(src):
        remaining = max_bytes - emitted
        if len(chunk) <= remaining:
            yield chunk
            emitted += len(chunk)
            continue
        if remaining > 0:
            yield chunk[:remaining]
        notice = _build_notice(limit)
        existing = (await materialize(io.stderr)
                    if io.stderr is not None else b"")
        io.stderr = existing + notice
        if limit.on_exceed is OnExceed.ERROR:
            io.exit_code = 1
        return


async def _error_stream(src: ByteSource, io: IOResult, limit: Limit,
                        command: str) -> AsyncIterator[bytes]:
    outcome = IOResult()
    data = await materialize(_bounded_stream(src, outcome, limit, command))
    if outcome.stderr is not None:
        io.stderr = await materialize(io.stderr) + await materialize(
            outcome.stderr)
    if outcome.exit_code:
        io.exit_code = outcome.exit_code
    elif data:
        yield data


def guard_io(stdout: ByteSource | None,
             io: IOResult,
             limit: Limit | None,
             command: str = "") -> ByteSource | None:
    """Bound a terminal stream and settle its outcome as its owner consumes it.

    Args:
        stdout (ByteSource | None): the command's output stream.
        io (IOResult): mutable outcome settled while stdout is consumed.
        limit (Limit | None): resolved output bound.
        command (str): command to identify in a truncation notice.
    """
    if stdout is None or limit is None or (limit.max_lines is None
                                           and limit.max_bytes is None):
        return stdout
    if limit.on_exceed is OnExceed.ERROR:
        return _error_stream(stdout, io, limit, command)
    return _bounded_stream(stdout, io, limit, command)


async def guard_output(
    stdout: ByteSource | None,
    stderr: ByteSource | None,
    exit_code: int,
    limit: Limit | None,
) -> tuple[ByteSource | None, ByteSource | None, int]:
    """Apply output caps at a boundary and merge the outcome.

    The one boundary rule, shared by the command tree and the
    whole-line runtimes: cap stdout, append the truncation notice to
    stderr, and let an ERROR-mode guard override the exit code.

    Args:
        stdout (ByteSource | None): the output to cap.
        stderr (ByteSource | None): the error stream to carry the
            notice.
        exit_code (int): the run's exit code.
        limit (Limit | None): resolved limit.
    """
    io = IOResult(stderr=stderr, exit_code=exit_code)
    guarded = guard_io(stdout, io, limit)
    data = await materialize(guarded) if guarded is not None else None
    return data, io.stderr, io.exit_code


async def apply_op_limit(result, limit: Limit | None):
    """Apply byte/line caps to a byte-producing VFS op result.

    VFS ops have no stderr/exit envelope, so on TRUNCATE the capped bytes
    are returned (and the notice logged) and on ERROR a
    LimitExceededError is raised. Non-byte results (stat, listings)
    and unconfigured guards pass through untouched.

    Args:
        result: the op result (capped only when bytes or a byte stream).
        limit (Limit | None): resolved op limit.
    """
    if limit is None:
        return result
    if limit.max_bytes is None and limit.max_lines is None:
        return result
    if not isinstance(result,
                      (bytes, bytearray)) and not hasattr(result, "__aiter__"):
        return result
    data, sg_io = await apply_limit(result, limit)
    if sg_io.exit_code != 0:
        message = (await sg_io.stderr_str()
                   if sg_io.stderr else "limit exceeded")
        raise LimitExceededError(message.strip())
    if sg_io.stderr:
        logger.debug("vfs op output truncated: %s",
                     (await sg_io.stderr_str()).strip())
    return data
