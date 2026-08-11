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

from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import Limit, OnExceed
from mirage.utils.stream import ensure_stream

logger = logging.getLogger(__name__)


class CommandTimeoutError(Exception):

    def __init__(self, command: str, seconds: float) -> None:
        super().__init__(f"{command}: timed out after {seconds}s")
        self.command = command
        self.seconds = seconds


class LimitExceededError(Exception):
    """A hard cap refused output the producer had already made.

    The cap is applied to a result that exists: at an op door the
    backend has already moved those bytes, and the door reports that
    through the caller's ``OpReport`` before the cap runs, so this
    error carries no accounting of its own.
    """


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


def _trim_to_lines(buf: bytes, max_lines: int) -> bytes:
    count = 0
    for i, byte in enumerate(buf):
        if byte == 0x0A:
            count += 1
            if count == max_lines:
                return buf[:i + 1]
    return buf


def _build_notice(limit: Limit) -> bytes:
    parts: list[str] = []
    if limit.max_lines is not None:
        parts.append(f"{limit.max_lines} lines")
    if limit.max_bytes is not None:
        parts.append(f"{limit.max_bytes} bytes")
    detail = " / ".join(parts)
    return (f"output truncated at limit ({detail}); "
            "narrow with grep, or read more with head -n / tail -n / "
            "a more specific path\n").encode()


async def apply_limit(
    src: ByteSource,
    limit: Limit | None,
) -> tuple[ByteSource | None, IOResult]:
    if limit is None:
        return src, IOResult()
    max_lines = limit.max_lines
    max_bytes = limit.max_bytes
    if max_lines is None and max_bytes is None:
        return src, IOResult()
    buf = bytearray()
    truncated = False
    async for chunk in ensure_stream(src):
        buf.extend(chunk)
        if max_bytes is not None and len(buf) > max_bytes:
            buf = bytearray(buf[:max_bytes])
            truncated = True
            break
        if max_lines is not None and buf.count(b"\n") >= max_lines:
            buf = bytearray(_trim_to_lines(bytes(buf), max_lines))
            truncated = True
            break
    data = bytes(buf)
    if not truncated:
        return data, IOResult()
    notice = _build_notice(limit)
    if limit.on_exceed is OnExceed.ERROR:
        return None, IOResult(exit_code=1, stderr=notice)
    return data, IOResult(stderr=notice)


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
    if stdout is None:
        return stdout, stderr, exit_code
    data, sg_io = await apply_limit(stdout, limit)
    if sg_io.stderr is not None:
        existing = (await materialize(stderr) if stderr is not None else b"")
        stderr = existing + await materialize(sg_io.stderr)
    if sg_io.exit_code != 0:
        exit_code = sg_io.exit_code
    return data, stderr, exit_code


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
