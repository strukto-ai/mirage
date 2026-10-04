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
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from functools import partial

from mirage.commands.spec.usage import read_fail_exit
from mirage.io.stream import ensure_stream
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.ops.types import LinkView, MountView, StatPath
from mirage.shell.bytes import encode_text
from mirage.types import (
    FileStat,
    FileType,
    PathSpec,
    PolymorphicReadFn,
    ReadBytesFn,
    StatFn,
)
from mirage.utils.errors import (
    FS_ERRORS,
    READ_FAILURES,
    DotWalkError,
    eisdir,
    fs_error_line,
)


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
        fallback = None if stat_path is None else await stat_path(path.virtual)
        if fallback is None:
            raise
        return fallback
    if mounts is not None and mounts.is_root(path.virtual):
        return row.model_copy(update={"name": operand_name(path)})
    return row


async def split_readable_coded(
    paths: list[PathSpec],
    stat: StatFn,
    cmd_name: str,
) -> tuple[list[PathSpec], bytes, int]:
    """``split_readable``, plus the exit code the failures add up to.

    The code is the gzip family's, which is the only reason this variant
    exists: gzip reports a directory as a warning (2) and a missing file
    as an error (1), where every other command in the family answers the
    same number whichever failure is asked, so ``split_readable`` just
    drops this one.

    Its rule is not "the last failure wins". An error is recorded
    outright while a warning is recorded only when nothing has failed
    yet, so the error outranks the warning in either order: ``zcat nope
    dir`` and ``zcat dir nope`` are both 1, and only an invocation with
    no error at all (``zcat dir ok.gz``) is 2. That is gzip's own code:
    ``progerror`` assigns ``exit_code = ERROR`` unconditionally while the
    ``WARN`` macro assigns ``only if (exit_code == OK)`` (gzip 1.13,
    pinned on debian:stable-slim). A command whose rule is different
    again has to own its own loop: GNU sed takes the most severe code,
    and ``sed_generic`` does that itself.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        stat (StatFn): Bound stat called as ``stat(path)``.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[PathSpec], bytes, int]: Readable operands, the
        concatenated stderr lines, and the exit code (0 when none
        failed).
    """
    readable: list[PathSpec] = []
    err = b""
    code = 0
    for p in paths:
        failure: BaseException | None = None
        try:
            st = await stat(p)
        except FS_ERRORS as exc:
            failure = exc
        else:
            if getattr(st, "type", None) == FileType.DIRECTORY:
                failure = eisdir(p)
        if failure is None:
            readable.append(p)
            continue
        err += encode_text(fs_error_line(cmd_name, p, failure))
        # A directory is gzip's warning and everything else its error, so
        # the directory yields to a code already recorded. Keyed on the
        # errno rather than on which branch reported it, because a keyed
        # backend raises EISDIR from the stat where an explicit directory
        # returns a row.
        if code == 0 or not isinstance(failure, IsADirectoryError):
            code = read_fail_exit(cmd_name, failure)
    return readable, err, code


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
    readable, err, _ = await split_readable_coded(paths, stat, cmd_name)
    return readable, err


async def split_opened(
    paths: list[PathSpec],
    stat: StatFn,
    cmd_name: str,
) -> tuple[list[PathSpec], frozenset[str], bytes]:
    """``split_readable`` for the commands that head each operand.

    GNU head and tail open an operand before they read it, and a
    directory opens: its ``==> name <==`` header prints and only the
    read after it fails. So a directory keeps its place among the
    opened operands, named in the unread set, while one that does not
    open at all (a missing name) is dropped as ``split_readable`` drops
    it.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        stat (StatFn): Bound stat called as ``stat(path)``.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[PathSpec], frozenset[str], bytes]: the operands that
        open, in order; the virtual paths among them whose read fails;
        and the stderr lines.
    """
    opened: list[PathSpec] = []
    unread: set[str] = set()
    err = b""
    for p in paths:
        failure: BaseException | None = None
        try:
            st = await stat(p)
        except FS_ERRORS as exc:
            failure = exc
        else:
            if getattr(st, "type", None) == FileType.DIRECTORY:
                failure = eisdir(p)
        if failure is not None:
            err += encode_text(fs_error_line(cmd_name, p, failure))
            if not isinstance(failure, READ_FAILURES):
                continue
            unread.add(p.virtual)
        opened.append(p)
    return opened, frozenset(unread), err


@dataclass(frozen=True, slots=True)
class ReadOperand:
    """One successfully read operand.

    Args:
        path (PathSpec): The operand that was read.
        data (bytes): Its materialized content.
    """

    path: PathSpec
    data: bytes


async def read_operands(
    paths: list[PathSpec],
    read: PolymorphicReadFn,
    cmd_name: str,
) -> tuple[list[ReadOperand], bytes]:
    """Read every operand eagerly, turning failures into GNU stderr lines.

    Each operand whose read fails with a filesystem error becomes one
    ``<cmd>: <path>: <strerror>`` line and the remaining operands still
    process (the read-family rule). Non-filesystem errors keep
    propagating. Mirrors ``readOperands`` in operands.ts.

    Args:
        paths (list[PathSpec]): Glob-resolved operands in command order.
        read (PolymorphicReadFn): Bound reader called as ``read(path)``;
            may return bytes, an awaitable of bytes, or a byte stream.
        cmd_name (str): Command name for the stderr prefix.

    Returns:
        tuple[list[ReadOperand], bytes]: The operands read in order, and
        the concatenated stderr lines for the failed ones.
    """
    ok: list[ReadOperand] = []
    err = b""
    for p in paths:
        try:
            source = read(p)
            if inspect.isawaitable(source):
                source = await source
            data = await materialize(source)
        except FS_ERRORS as exc:
            err += encode_text(fs_error_line(cmd_name, p, exc))
            continue
        ok.append(ReadOperand(p, data))
    return ok, err


def operands_io(
    err: bytes, cache: list[str] | None = None, exit_code: int = 1
) -> IOResult:
    """IOResult carrying operand-split stderr lines.

    Exit ``exit_code`` when any operand failed, exit 0 otherwise; mirrors
    ``operandsIo`` in operands.ts. The default is 1, which is every GNU
    command in this family except the gzip one, whose code depends on the
    errno and which passes the number ``split_readable_coded`` reports.

    Args:
        err (bytes): Concatenated stderr lines, ``b""`` for none.
        cache (list[str] | None): Paths worth caching, if any.
        exit_code (int): The code to report when ``err`` is non-empty.
    """
    return IOResult(
        exit_code=0 if not err else exit_code,
        stderr=err or None,
        cache=cache if cache is not None else [],
    )


async def merge_split_errors(
    result: tuple[ByteSource | None, IOResult],
    err: bytes,
    exit_code: int = 1,
) -> tuple[ByteSource | None, IOResult]:
    """Attach ``split_readable`` stderr lines to a generic's result.

    Args:
        result (tuple[ByteSource | None, IOResult]): The body's return.
        err (bytes): Stderr lines for the operands dropped by the split;
            when non-empty the command exits ``exit_code``.
        exit_code (int): The code to report, 1 for every GNU command in
            this family except the gzip one (see ``operands_io``).
    """
    if not err:
        return result
    out, io = result
    existing = await materialize(io.stderr) if io.stderr else b""
    io.stderr = existing + err
    io.exit_code = exit_code
    return out, io


async def _awaited_stream(
    source: "Awaitable[bytes | AsyncIterator[bytes]]",
) -> AsyncIterator[bytes]:
    async for chunk in ensure_stream(await source):
        yield chunk


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
