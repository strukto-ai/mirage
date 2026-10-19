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
import functools
import inspect
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.commands.config import CommandFnResult, Context
from mirage.commands.errors import PartialOutputError, UsageError
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.concurrency.limiter import run_blocking
from mirage.errors.fs import error_path, fs_strerror
from mirage.errors.render import format_fs_error
from mirage.errors.types import CommandTimeoutError
from mirage.io.cooperative import chunks
from mirage.io.errors import PipeClosed
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, CommandOutput, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import Limit, PathSpec, Producer
from mirage.workspace.files import Files, reader_of

logger = logging.getLogger(__name__)

# What a voice says for one failure: the bytes the handler printed
# before it, the diagnostic line and the exit code.
Failure = tuple[ByteSource | None, bytes, int]


@dataclass(frozen=True, slots=True)
class HandlerVoice:
    """How a caller words a handler that failed, before it answered or
    while its output streamed.

    The runner is one for a mount command and a CLI leaf; the wording is
    the caller's, and stays what each said before the two shared it.
    Mirrors the TS ``HandlerVoice`` (workspace/executor/command/handler.ts).

    Args:
        fail (Callable[[Exception], Failure]): the failure as this caller
            words it.
        passes (tuple[type[BaseException], ...]): the failures that are
            not the command's to word, which reach the workspace instead
            (a limit timeout answers 124 there).
        splits (bool): whether output is pulled through ``chunks``, which
            splits even a single blob, so an answer in bytes streams too.
    """

    fail: Callable[[Exception], Failure]
    passes: tuple[type[BaseException], ...]
    splits: bool = False


def _leaf_message(exc: BaseException) -> str:
    """What a failed leaf says after its name: a file error stamped with
    its path as the path and phrase, the way the shell's own commands say
    it, anything else in its own words.

    Args:
        exc (BaseException): the leaf's failure.
    """
    strerror = fs_strerror(exc)
    if strerror is None or not isinstance(getattr(exc, "filename", None), str):
        return str(exc)
    return f"{error_path(exc)}: {strerror}"


def _mount_failure(
    name: str, paths: list[PathSpec], exc: Exception
) -> Failure:
    """A mount command's failure, worded like GNU (``prog: message``),
    a file error with the path as typed.

    Args:
        name (str): the command name.
        paths (list[PathSpec]): the operands as typed.
        exc (Exception): the failure.
    """
    logger.debug("%s failed", name, exc_info=exc)
    code = (
        exc.exit_code
        if isinstance(exc, UsageError)
        else read_fail_exit_code(name, exc)
    )
    return None, format_fs_error(name, exc, paths), code


def _leaf_failure(prog: str, exc: Exception) -> Failure:
    """A CLI leaf's failure: a usage error in its own words and exit
    code, anything else after the program's name with exit 1, and what
    the leaf printed before it failed kept.

    Args:
        prog (str): the program and its verb path.
        exc (Exception): the failure.
    """
    printed = exc.stdout if isinstance(exc, PartialOutputError) else None
    if isinstance(exc, UsageError):
        return printed, encode_text(f"{exc}\n"), exc.exit_code
    return printed, encode_text(f"{prog}: {_leaf_message(exc)}\n"), 1


def mount_voice(name: str, paths: list[PathSpec]) -> HandlerVoice:
    """The voice of a command a mount runs.

    Args:
        name (str): the command name.
        paths (list[PathSpec]): the operands as typed, which a file error
            names.
    """
    return HandlerVoice(
        fail=functools.partial(_mount_failure, name, paths),
        passes=(CommandTimeoutError, PipeClosed),
    )


def cli_voice(prog: str) -> HandlerVoice:
    """The voice of a CLI leaf, installed or on a mount.

    Args:
        prog (str): the program and its verb path.
    """
    return HandlerVoice(
        fail=functools.partial(_leaf_failure, prog),
        passes=(CommandTimeoutError,),
        splits=True,
    )


async def call_leaf(
    fn: Callable[..., Any],
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> Any:
    """Run a leaf handler, whether it was written ``async def`` or not.

    Async handlers run on the workspace loop. Synchronous Python handlers
    run in an owned thread so blocking SDK calls cannot stall the loop.
    Cancellation waits for that thread before releasing the session.

    Args:
        fn (Callable[..., Any]): the leaf's handler.
        accessor (Accessor): the install's accessor, or the mount's.
        paths (list[PathSpec]): the cwd-resolved path operands.
        texts (list[str]): the text operands.
        ctx (Context): the leaf's context, the one a command gets.
    """
    result = (
        fn(accessor, paths, texts, ctx)
        if inspect.iscoroutinefunction(fn)
        or inspect.iscoroutinefunction(getattr(fn, "__call__", None))
        else await run_blocking(fn, accessor, paths, texts, ctx)
    )
    if inspect.isawaitable(result):
        return await result
    return result


async def answered(body: Awaitable[CommandFnResult]) -> CommandOutput:
    """A leaf's answer, an empty one where it returned None.

    A mount command's None declines, so its mount tries the next
    handler; a leaf's None is its whole answer, an empty one.

    Args:
        body (Awaitable[CommandFnResult]): the started leaf call.
    """
    out = await body
    return out if out is not None else (None, IOResult())


async def run_handler(
    body: Awaitable[CommandFnResult],
    name: str,
    limit: Limit | None,
    producer: Producer,
    voice: HandlerVoice,
    drop: Callable[[], Awaitable[None]] | None = None,
    scope: Callable[[CommandOutput], CommandOutput] | None = None,
    frame: bool = True,
    vfs: Files | None = None,
) -> CommandFnResult:
    """Run one handler body: a mount command's, or a CLI leaf's.

    The body runs under the resolved limit's timeout, which must bound
    it as well as its output: an eager handler does its work inside the
    call, where the stream guard never runs. A usage error is the
    handler's own words and exit code; any other failure is worded in
    the caller's voice, so the rest of the line keeps running. A handler
    that may have written past the dispatcher drops caches afterwards,
    whether it answered, failed (in its own words too), timed out or was
    cancelled, since its write may have landed either way, and again once
    an answer that streams has ended or been closed, since a stream does
    its work as it is pulled. An answer carries the producer the
    output limits resolve from and has its stream framed so a failure
    while it streams is worded too; a failure the runner framed carries
    no producer. None is the handler declining, which a mount's cascade
    reads as "try the next handler". Rows a handler hands over in place
    of stdout (``IOResult.rows``) lose those the session cannot see and
    are rendered here, inside the timeout, so this is the one place a
    command's output meets the session's hides.

    Args:
        body (Awaitable[CommandFnResult]): the started handler call.
        name (str): the command the timeout names.
        limit (Limit | None): the resolved limit.
        producer (Producer): the facts the output guards resolve from.
        voice (HandlerVoice): how the caller words a failure.
        drop (Callable[[], Awaitable[None]] | None): drops the caches a
            write past the dispatcher leaves stale; None when the
            handler writes nothing or only through the dispatcher.
        scope (Callable[[CommandOutput], CommandOutput] | None): what the
            caller wraps an answer in before it is framed (a mount binds
            its recorder and revisions to the stream).
        frame (bool): whether to frame the answer's stream; a script
            leaf's comes back from its runtime already worded.
        vfs (Files | None): the handler's files, whose session's hides
            filter the rows it hands over; None filters none.
    """
    timeout = limit.timeout_seconds if limit is not None else None
    try:
        out = await run_with_timeout(_rendered(body, vfs, name), timeout, name)
    except (CommandTimeoutError, asyncio.CancelledError):
        if drop is not None:
            await drop()
        raise
    except Exception as exc:
        if drop is not None:
            await drop()
        if isinstance(exc, UsageError):
            return None, IOResult(
                exit_code=exc.exit_code, stderr=encode_text(f"{exc}\n")
            )
        if isinstance(exc, voice.passes):
            raise
        printed, stderr, code = voice.fail(exc)
        return printed, IOResult(exit_code=code, stderr=stderr)
    if drop is not None:
        await drop()
    if out is None:
        return None
    source = out[0]
    stream, io = scope(out) if scope is not None else out
    io.producer = producer
    pulled: AsyncIterator[bytes]
    if (
        not frame
        or stream is None
        or (isinstance(stream, bytes) and not voice.splits)
    ):
        if drop is None or stream is None or isinstance(stream, bytes):
            return stream, io
        pulled = stream
    else:
        pulled = _framed(stream, io, voice)
    lazy = not isinstance(stream, bytes)

    async def close() -> None:
        await close_quietly(source)
        await close_quietly(stream)
        if drop is not None and lazy:
            await drop()

    return OutputStream(pulled, close), io


async def _rendered(
    body: Awaitable[CommandFnResult], vfs: Files | None, name: str
) -> CommandFnResult:
    """A handler's answer with the rows it handed over rendered: those
    the session cannot see dropped first.

    Args:
        body (Awaitable[CommandFnResult]): the started handler call.
        vfs (Files | None): the handler's files; None filters none.
        name (str): the command, for a handler that hands over both.
    """
    out = await body
    if out is None:
        return out
    stdout, io = out
    rows = io.rows
    if rows is None:
        return out
    if stdout is not None:
        await close_quietly(stdout)
        raise ValueError(f"{name}: hands over both rows and stdout")
    io.rows = None
    items = list(rows.items)
    if vfs is not None:
        reader = reader_of(vfs)
        items = [row for row in items if reader.visible(row.path)]
    return await rows.render(items), io


async def _framed(
    source: ByteSource, io: IOResult, voice: HandlerVoice
) -> AsyncIterator[bytes]:
    """Keep a deferred failure on its command, after any emitted bytes.

    Args:
        source (ByteSource): the handler's output.
        io (IOResult): its result, finalized when the stream ends.
        voice (HandlerVoice): how the caller words the failure.
    """
    pulled: AsyncIterator[bytes]
    if voice.splits or isinstance(source, bytes):
        pulled = chunks(source)
    else:
        pulled = source
    try:
        async for chunk in pulled:
            yield chunk
    except voice.passes:
        raise
    except Exception as exc:
        printed, stderr, code = voice.fail(exc)
        if printed is not None:
            async for chunk in chunks(printed):
                yield chunk
        io.stderr = await io.materialize_stderr() + stderr
        io.exit_code = code
    finally:
        await close_quietly(source)
