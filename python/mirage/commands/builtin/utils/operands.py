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

import inspect
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import replace
from functools import partial

from mirage.commands.builtin.constants import OPERAND_CONCURRENCY
from mirage.concurrency.limiter import bounded_map
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import eisdir
from mirage.errors.render import fs_error_line
from mirage.errors.types import DotWalkError
from mirage.io.cooperative import chunks
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import encode_text
from mirage.types import (
    FileStat,
    FileType,
    PathSpec,
    PolymorphicReadFn,
    ReadBytesFn,
    StatFn,
)
from mirage.view.types import LinkView, MountView, StatPath


def mount_points(mounts: MountView | None, directory: str) -> list[str]:
    """The mount roots a walk of ``directory`` reaches first, sorted.

    Each one is the edge of the directory's own filesystem: the roots
    under no other visible mount below the directory, so a mount nested
    in a mount is not one of them.

    Args:
        mounts (MountView | None): the mount boundaries.
        directory (str): the directory walked, a virtual path.
    """
    if mounts is None:
        return []
    roots = mounts.visible_descendants(directory)
    return sorted(
        root
        for root in roots
        if not any(root.startswith(other + "/") for other in roots)
    )


def operand_name(path: PathSpec) -> str:
    """What a stat row's ``name`` should say for this operand.

    The basename, or ``/`` for the workspace root, which is the spelling
    ``namespace_stat`` already uses for a namespace-only directory.

    Args:
        path (PathSpec): the operand.
    """
    return path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"


async def operand_stat(
    path: PathSpec,
    *,
    stat_fn: StatFn,
    stat_path: StatPath | None = None,
    mounts: MountView | None = None,
    links: LinkView | None = None,
) -> FileStat:
    """Stat one operand the way a reporting command needs it.

    Two things no single backend stat can get right, both about paths
    that are namespace structure rather than backend state:

    A path that only exists because mounts or links sit under it (``/repos``
    when ``/repos/alpha`` is mounted) has no backend to answer for it, so the
    backend stat raises and the operand reads as absent. ``stat_path``
    routes through the dispatcher, which answers such a path from the
    namespace, so it is asked second and only on a miss. Its row is
    already named from the path.

    A mount root has a backend, but that backend names its own root
    rather than the path: ram answers ``/``, and disk answers the host
    directory's basename, which leaks the path behind the mount. So the
    row is renamed here, the way ``ls`` renames a child-mount row for the
    same reason.

    Args:
        path (PathSpec): the operand to stat.
        stat_fn (StatFn): the backend stat.
        stat_path (StatPath | None): dispatcher-backed stat of one path;
            absent outside a workspace.
        mounts (MountView | None): the mount boundaries; absent outside a
            workspace.
        links (LinkView | None): namespace links, including descendants
            that can make an otherwise absent directory exist.

    Raises:
        OSError: neither channel could answer, re-raised from the backend
            so the caller reports the error it would have reported.
    """
    try:
        row = await stat_fn(path)
    except DotWalkError:
        # The operand did not resolve, so no namespace structure under
        # the path it simplifies to can answer for it.
        raise
    except FS_ERRORS:
        if (
            mounts is not None
            and not mounts.visible_descendants(path.virtual)
            and (links is None or not links.subtree(path.virtual))
        ):
            raise
        fallback = None if stat_path is None else await stat_path(path)
        if fallback is None:
            raise
        return fallback
    if mounts is not None and mounts.is_root(path.virtual):
        return replace(row, name=operand_name(path))
    return row


async def split_readable(
    paths: list[PathSpec],
    stat: StatFn,
    cmd_name: str,
) -> tuple[list[PathSpec], bytes]:
    """Partition operands into readable paths and GNU stderr lines.

    Read-family commands (cat/head/tail/wc) process remaining operands
    after one fails, per GNU coreutils: each failed operand becomes one
    ``<cmd>: <path>: <strerror>`` line and the command exits 1 while
    still emitting output for the operands that resolved. Each path is
    stat'ed eagerly so a lazy output stream never aborts mid-drain on a
    missing operand. A directory operand is refused with GNU's ``Is a
    directory``: explicit directories via the stat type here, implicit
    keyed-backend directories via the ``dir_aware_stat`` wiring (#457).
    Non-filesystem errors keep propagating. Lives inside the generics so
    every wrapper — factory builders and bespoke backend commands alike
    — inherits the behavior; mirrors ``splitReadable`` in operands.ts.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        stat (StatFn): Bound stat called as ``stat(path)``.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[PathSpec], bytes]: Readable operands in order, and the
        concatenated stderr lines for the failed ones (``b""`` if none).
    """
    order = await split_in_order(paths, stat, cmd_name)
    readable = [p for p in order if isinstance(p, PathSpec)]
    return readable, b"".join(p for p in order if isinstance(p, bytes))


async def split_in_order(
    paths: list[PathSpec],
    stat: StatFn,
    cmd_name: str,
) -> list[PathSpec | bytes]:
    """``split_readable``'s partition kept in operand order: each
    operand that reads, or the stderr line of one that failed, where it
    stood, for ``in_order`` to say when the output reaches it.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        stat (StatFn): Bound stat called as ``stat(path)``.
        cmd_name (str): Command name for the stderr prefix.
    """
    order: list[PathSpec | bytes] = []
    for p, st in zip(paths, await _statted(paths, stat)):
        if isinstance(st, Exception):
            order.append(encode_text(fs_error_line(cmd_name, p, st)))
            continue
        if getattr(st, "type", None) == FileType.DIRECTORY:
            order.append(encode_text(fs_error_line(cmd_name, p, eisdir(p))))
            continue
        order.append(p)
    return order


async def _statted(
    paths: list[PathSpec], stat: StatFn
) -> list[FileStat | Exception]:
    """Each operand's stat in operand order, ``OPERAND_CONCURRENCY`` at
    once, so a store's round trips overlap: a filesystem failure stands
    in its place, its traceback dropped so no frame cycle outlives it,
    and any other propagates.

    Args:
        paths (list[PathSpec]): the operands.
        stat (StatFn): Bound stat called as ``stat(path)``.
    """

    async def one(path: PathSpec) -> FileStat | Exception:
        try:
            return await stat(path)
        except FS_ERRORS as exc:
            return exc.with_traceback(None)

    return await bounded_map(paths, one, OPERAND_CONCURRENCY)


async def in_order(
    parts: Sequence[AsyncIterator[bytes] | bytes], io: IOResult
) -> AsyncIterator[bytes]:
    """The parts' streams one after another, each bytes part a failed
    operand's stderr line said on ``io`` when the output reaches it, as
    GNU reports an operand and goes on (``cat a missing b``). A reader
    that stops early still finds the lines it never reached on ``io``,
    after what it read. Lines that meet with no output between them are
    said together, so a run of them costs one copy of what ``io``
    holds. Mirrors TypeScript's ``inOrder``.

    Args:
        parts (Sequence[AsyncIterator[bytes] | bytes]): each operand's
            output, or its stderr line.
        io (IOResult): the result the lines are said on.
    """
    lines = [p for p in parts if isinstance(p, bytes)]
    reached = said = 0
    try:
        for part in parts:
            if isinstance(part, bytes):
                reached += 1
                continue
            if said < reached:
                await say(io, b"".join(lines[said:reached]))
                said = reached
            async for chunk in part:
                yield chunk
    finally:
        if said < len(lines):
            await say(io, b"".join(lines[said:]))
        for part in parts:
            if not isinstance(part, bytes):
                await close_quietly(part)


def at_offsets(
    body: bytes, notes: Sequence[tuple[int, bytes]], io: IOResult
) -> ByteSource:
    """``body`` with each note, a stderr line and the offset in ``body``
    it was written before, said on ``io`` when the output reaches it, for
    a command that renders all it prints before it prints (``wc a
    missing b``); ``body`` itself when there is no note.

    Args:
        body (bytes): the rendered output.
        notes (Sequence[tuple[int, bytes]]): each line and its offset,
            in order.
        io (IOResult): the result the lines are said on.
    """
    if not notes:
        return body
    parts: list[AsyncIterator[bytes] | bytes] = []
    start = 0
    for offset, line in notes:
        if offset > start:
            parts.append(chunks(body[start:offset]))
        parts.append(line)
        start = max(start, offset)
    parts.append(chunks(body[start:]))
    return in_order(parts, io)


async def split_opened(
    paths: list[PathSpec],
    stat: StatFn,
    cmd_name: str,
) -> tuple[list[PathSpec | bytes], dict[str, bytes]]:
    """``split_in_order`` for the commands that head each operand.

    GNU head and tail open an operand before they read it, and a
    directory opens: its ``==> name <==`` header prints and only the
    read after it fails. So a directory keeps its place among the
    opened operands, its line said after its header, while one that
    does not open at all (a missing name) leaves its line where it
    stood, as ``split_in_order`` does.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        stat (StatFn): Bound stat called as ``stat(path)``.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[PathSpec | bytes], dict[str, bytes]]: the operands
        that open and the lines of those that do not, in order; and the
        line of each opened one whose read fails, by its spelling, so
        ``head d d/`` names each.
    """
    order: list[PathSpec | bytes] = []
    unread: dict[str, bytes] = {}
    for p, st in zip(paths, await _statted(paths, stat)):
        if isinstance(st, Exception):
            line = encode_text(fs_error_line(cmd_name, p, st))
            if not isinstance(st, READ_FAILURES):
                order.append(line)
                continue
            unread[p.raw_path] = line
        else:
            if getattr(st, "type", None) == FileType.DIRECTORY:
                unread[p.raw_path] = encode_text(
                    fs_error_line(cmd_name, p, eisdir(p))
                )
        order.append(p)
    return order, unread


def operand_lines(
    order: list[PathSpec | bytes], unread: Mapping[str, bytes]
) -> dict[int, bytes]:
    """Each stderr line of a ``split_opened`` partition by its operand's
    index, in operand order: a command pops each as it says it, and
    says what is left once its reader stops.

    Args:
        order (list[PathSpec | bytes]): the partition.
        unread (Mapping[str, bytes]): the lines of opened operands.
    """
    lines: dict[int, bytes] = {}
    for i, p in enumerate(order):
        line = p if isinstance(p, bytes) else unread.get(p.raw_path)
        if line:
            lines[i] = line
    return lines


async def say(io: IOResult, line: bytes) -> None:
    """Say an operand's stderr line on ``io`` after what it holds.

    Args:
        io (IOResult): the result.
        line (bytes): the line.
    """
    if io.stderr is not None and not isinstance(io.stderr, bytes):
        await io.materialize_stderr()
    io.add_stderr(line)


def operands_io(err: bytes) -> IOResult:
    """IOResult carrying operand-split stderr lines.

    Exit 1 when any operand failed, exit 0 otherwise; mirrors
    ``operandsIo`` in operands.ts.

    Args:
        err (bytes): Concatenated stderr lines, ``b""`` for none.
    """
    return IOResult(exit_code=1 if err else 0, stderr=err or None)


async def merge_split_errors(
    result: tuple[ByteSource | None, IOResult],
    err: bytes,
) -> tuple[ByteSource | None, IOResult]:
    """Attach ``split_readable`` stderr lines to a generic's result.

    Args:
        result (tuple[ByteSource | None, IOResult]): The body's return.
        err (bytes): Stderr lines for the operands dropped by the split;
            when non-empty the command exits 1.
    """
    if not err:
        return result
    out, io = result
    existing = await materialize(io.stderr) if io.stderr else b""
    io.stderr = existing + err
    io.exit_code = 1
    return out, io


async def reported_stream(
    source: AsyncIterator[bytes], io: IOResult, path: PathSpec, cmd_name: str
) -> AsyncIterator[bytes]:
    """Report a deferred filesystem error while allowing later operands.

    A read that fails once the stat passed is reported like a missing
    operand, and the next operand still prints. Mirrors TypeScript's
    ``reportedStream``.

    Args:
        source (AsyncIterator[bytes]): the operand's bytes.
        io (IOResult): the result its failure is reported on.
        path (PathSpec): the operand.
        cmd_name (str): the command whose diagnostic is reported.
    """
    try:
        async for chunk in source:
            yield chunk
    except FS_ERRORS as exc:
        await report_fs_error(io, cmd_name, path, exc)
    finally:
        await close_quietly(source)


async def report_fs_error(
    io: IOResult, cmd_name: str, path: PathSpec, exc: BaseException
) -> None:
    """Report one operand's filesystem failure on a result whose output
    goes on: its ``fs_error_line`` lands after the stderr already there,
    and the exit code becomes 1.

    Args:
        io (IOResult): the result the failure is reported on.
        cmd_name (str): the command whose diagnostic is reported.
        path (PathSpec): the operand that failed.
        exc (BaseException): the failure.
    """
    await say(io, encode_text(fs_error_line(cmd_name, path, exc)))
    io.exit_code = 1


def per_operand(
    paths: Sequence[PathSpec | bytes],
    read: Callable[[PathSpec], AsyncIterator[bytes]],
    stdin: ByteSource | None,
    io: IOResult,
    cmd_name: str,
    each: Callable[[ByteSource], AsyncIterator[bytes]],
) -> AsyncIterator[bytes]:
    """``each`` over every operand in turn, or over stdin without one;
    a failed operand's line (``split_in_order``) is said where it stood.

    Mirrors TypeScript's ``perOperand``.

    Args:
        paths (Sequence[PathSpec | bytes]): the operands, and the stderr
            line of each that did not read.
        read (Callable[[PathSpec], AsyncIterator[bytes]]): opens one.
        stdin (ByteSource | None): the input when there is no operand.
        io (IOResult): where a failed operand is reported.
        cmd_name (str): the command the report names.
        each (Callable[[ByteSource], AsyncIterator[bytes]]): what one
            input becomes.
    """
    if not paths:
        return each(stdin or b"")
    return in_order(
        [
            p
            if isinstance(p, bytes)
            else each(reported_stream(read(p), io, p, cmd_name))
            for p in paths
        ],
        io,
    )


async def errors_first(
    result: tuple[ByteSource | None, IOResult], err: bytes
) -> tuple[ByteSource | None, IOResult]:
    """``merge_split_errors`` for a command whose lines come before its
    output, as GNU's do when it holds its output until it ends (``rev``,
    ``tac``).

    Args:
        result (tuple[ByteSource | None, IOResult]): The body's return.
        err (bytes): Stderr lines for the operands dropped by the split;
            when non-empty the command exits 1.
    """
    out, io = result
    if not err:
        return result
    io.exit_code = 1
    if out is None:
        await say(io, err)
        return None, io
    return in_order([err, chunks(out)], io), io


async def _awaited_stream(
    source: "Awaitable[bytes | AsyncIterator[bytes]]",
) -> AsyncIterator[bytes]:
    stream = ensure_stream(await source)
    try:
        async for chunk in stream:
            yield chunk
    finally:
        await close_quietly(stream)


def _call_normalized(
    read: PolymorphicReadFn, path: PathSpec
) -> AsyncIterator[bytes]:
    # The reader is invoked NOW, not when the returned stream is first
    # drained: a cache-aware factory reader captures the active cache
    # manager at call time, inside the command's cache-manager scope,
    # which is gone by drain time. Only the rare awaitable-of-bytes
    # reader keeps a deferred step, and it carries no such scope.
    source = read(path)
    if inspect.isawaitable(source):
        return _awaited_stream(source)
    return ensure_stream(source)


def normalized_read(
    read: PolymorphicReadFn,
) -> Callable[[PathSpec], AsyncIterator[bytes]]:
    """Normalize a polymorphic bound reader to always yield a stream.

    The loose ``read`` contract lets a backend hand back bytes, an
    awaitable of bytes, or an async byte stream; a generic that streams
    per operand wants exactly one shape.

    Args:
        read (PolymorphicReadFn): Bound reader called as ``read(path)``.
    """
    if inspect.iscoroutinefunction(read):
        # Binding a coroutine does not capture a cache scope. Delay its
        # creation too, so an unused operand leaves nothing unawaited.
        async_read = read

        async def stream(path: PathSpec) -> AsyncIterator[bytes]:
            source = _awaited_stream(async_read(path))
            try:
                async for chunk in source:
                    yield chunk
            finally:
                await close_quietly(source)

        return stream
    return partial(_call_normalized, read)


async def _read_materialized(read: PolymorphicReadFn, path: PathSpec) -> bytes:
    source = read(path)
    if inspect.isawaitable(source):
        source = await source
    return await materialize(source)


def materialized_read(read: PolymorphicReadFn) -> ReadBytesFn:
    """Normalize a polymorphic bound reader to always return bytes.

    The buffering twin of ``normalized_read``, for generic bodies that
    take a whole-file ``read_bytes`` reader.

    Args:
        read (PolymorphicReadFn): Bound reader called as ``read(path)``.
    """
    return partial(_read_materialized, read)
