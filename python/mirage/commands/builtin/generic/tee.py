import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from enum import Enum, auto
from functools import partial

from mirage.commands.builtin.utils.paths import (
    absent_dest_error,
    entry_kind,
)
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.fs import eisdir, enotdir, fs_error, fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.render import fs_error_line
from mirage.errors.types import FsCondition
from mirage.io.cooperative import chunks
from mirage.io.errors import PipeClosed
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, ClosedPipe, IOResult, materialize
from mirage.io.writer import ByteWriter
from mirage.shell.bytes import encode_text
from mirage.shell.constants import SIGPIPE_STATUS
from mirage.types import PathSpec, StatFn
from mirage.utils.key_prefix import mount_key

logger = logging.getLogger(__name__)


class PipeErrors(Enum):
    """How tee answers a write into a pipe whose reader has gone: SIGPIPE
    without -p and --output-error, nothing under a -nopipe mode, a write
    error's report under warn and exit.
    """

    SIGNAL = auto()
    IGNORE = auto()
    REPORT = auto()


@dataclass(frozen=True, slots=True)
class TeeFlags:
    append: bool = False
    stop_on_error: bool = False
    pipe_errors: PipeErrors = PipeErrors.SIGNAL


def parse_flags(flags: Mapping[str, FlagValue]) -> TeeFlags:
    # --output-error values are validated declaratively: the spec's
    # choices= makes the parser report any other value and the executor
    # refuse with GNU's invalid-argument lines before tee runs. -p and a bare
    # --output-error are warn-nopipe; the last one typed wins, as GNU's one
    # option does.
    fl = FlagView(flags, spec=SPECS["tee"])
    mode: str | None = None
    for _, value in fl.occurrences("p", "output_error"):
        mode = value if isinstance(value, str) else "warn-nopipe"
    return TeeFlags(
        append=fl.as_bool("append"),
        stop_on_error=mode in ("exit", "exit-nopipe"),
        pipe_errors=(
            PipeErrors.SIGNAL
            if mode is None
            else PipeErrors.IGNORE
            if mode.endswith("-nopipe")
            else PipeErrors.REPORT
        ),
    )


def error_line(path: PathSpec, exc: Exception, root: str = "") -> bytes:
    """GNU's diagnostic for one unwritable operand.

    A recognized filesystem refusal reads like GNU (operand as typed,
    shared strerror); anything else keeps its own message, which is the
    only description of the cause a transport error has.

    Args:
        path (PathSpec): the operand that could not be written.
        exc (Exception): the refusal.
        root (str): the prefix of the mount the command runs on, below
            which the operand is named; empty across mounts.
    """
    if fs_strerror(exc) is not None:
        return encode_text(fs_error_line("tee", path, exc))
    return encode_text(f"tee: /{mount_key(path.virtual, root)}: {exc}\n")


async def write_one(
    path: PathSpec,
    raw: bytes,
    parsed: TeeFlags,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None,
) -> None:
    """Write one operand.

    A native append sends only the new bytes, which costs one read on the
    next access and saves reading and re-uploading the whole object on
    this one.

    Args:
        path (PathSpec): the operand to write.
        raw (bytes): what tee was handed.
        parsed (TeeFlags): the parsed flags.
        read_stream (Callable): backend read, for the emulated append.
        write_bytes (Callable): backend whole-file write.
        append_bytes (Callable | None): backend native append, when the
            backend wired the slot.
    """
    if not parsed.append:
        await write_bytes(path, raw)
        return
    if append_bytes is not None:
        await append_bytes(path, raw)
        return
    existing = b""
    try:
        existing = await materialize(read_stream(path))
    except FileNotFoundError as exc:
        # GNU tee -a creates a missing file: append to empty.
        logger.debug("appending to a new file at %s: %s", path.virtual, exc)
    await write_bytes(path, existing + raw)


async def open_refusal(
    stat: StatFn, path: PathSpec, opened: list[PathSpec]
) -> OSError | None:
    """The error GNU's open of an output would meet, or None.

    GNU opens the outputs in order, so each earlier one is a regular file
    by now: an output under one of them is ``Not a directory``.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        path (PathSpec): the output operand.
        opened (list[PathSpec]): the outputs opened before it.
    """
    if any(
        path.virtual.startswith(f"{o.virtual.rstrip('/')}/") for o in opened
    ):
        return enotdir(path)
    exists, is_dir = await entry_kind(stat, path)
    if is_dir:
        return eisdir(path)
    if exists:
        return None
    condition = await absent_dest_error(stat, path)
    if condition is None:
        return None
    return fs_error(path, condition)


async def write_output(
    paths: list[PathSpec],
    raw: bytes,
    parsed: TeeFlags,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None = None,
    stat: StatFn | None = None,
    opened_paths: list[PathSpec] | None = None,
    root: str = "",
) -> tuple[ByteSource | None, IOResult]:
    """Copy ``raw`` to every operand, GNU-style.

    An operand that cannot be written is diagnosed and skipped rather
    than ending the run: GNU keeps going and still writes the rest, and
    only ``--output-error=exit`` stops at the first failure. stdin always
    reaches stdout either way.

    "Cannot be written" is any exception the backend raises, not just
    ``OSError``. Most remote writes forward their SDK's own error class —
    ``core/s3/write.py`` hands back botocore's ``ClientError``,
    ``core/gridfs/write.py`` pymongo's ``PyMongoError`` — and none of
    those is an ``OSError``, so narrowing the catch would let one
    unreachable operand abort the whole command. ``error_line`` already
    tells the two apart, and this is not swallowing: every caught error is
    named on stderr and the command exits 1. ``Exception`` rather than
    ``BaseException`` keeps cancellation propagating.

    An output's open is probed before its write whenever ``stat`` is in
    hand, since a store would otherwise keep the key over a directory or
    under a file; a missing parent is the write's to refuse, which a
    keyed store makes as a redirect does. GNU opens every operand up
    front, so under ``exit`` an *open*
    failure aborts before any data is written, the outputs opened before
    it left empty. A mount has no open/write split (``write_bytes`` is one
    call), so with ``stat`` in hand the open is probed first: a missing
    or non-directory parent, or a directory operand. A probe the backend
    will not answer (a stat its credentials refuse) is no verdict, so
    that output is opened for real, by writing it nothing, once the
    outputs before it are opened. Opening an earlier output can fail
    first, and then it is the one reported.

    Args:
        paths (list[PathSpec]): every output operand, in order.
        raw (bytes): what tee was handed, and what reaches stdout.
        parsed (TeeFlags): the parsed flags.
        read_stream (Callable): backend read, for the emulated append.
        write_bytes (Callable): backend whole-file write.
        append_bytes (Callable | None): backend native append, if wired.
        stat (StatFn | None): Stats a path, for the probed open.
        root (str): the prefix of the mount the command runs on, below
            which a transport error names its operand.
    """
    errors: list[bytes] = []
    if parsed.stop_on_error and stat is not None:
        opened: set[str] = set()
        for index, path in enumerate(paths):
            probed = True
            refusal: Exception | None = None
            try:
                refusal = await open_refusal(stat, path, paths[:index])
            except Exception as exc:
                logger.debug("tee: probing %s failed: %s", path.virtual, exc)
                probed = False
            if probed and refusal is None:
                continue
            failed: PathSpec = path
            for prior in paths[:index]:
                if prior.virtual in opened:
                    continue
                try:
                    if not (
                        parsed.append and (await entry_kind(stat, prior))[0]
                    ):
                        await write_bytes(prior, b"")
                except Exception as exc:
                    failed, refusal = prior, exc
                    break
                opened.add(prior.virtual)
            if refusal is None:
                try:
                    await write_one(
                        path,
                        b"",
                        parsed,
                        read_stream,
                        write_bytes,
                        append_bytes,
                    )
                except Exception as exc:
                    refusal = exc
                else:
                    opened.add(path.virtual)
                    continue
            return None, IOResult(
                exit_code=1, stderr=error_line(failed, refusal, root)
            )
    for index, path in enumerate(paths):
        # A store keeps a key over a directory or under a file, where an
        # open would fail, so the open is probed for every output, not
        # only the ones --output-error=exit probed above.
        refusal = None
        # Under exit every output was proved or opened above.
        proved = stat is not None and parsed.stop_on_error
        if stat is not None and not parsed.stop_on_error:
            try:
                refusal = await open_refusal(stat, path, paths[:index])
                proved = refusal is None
            except Exception as exc:
                logger.debug("tee: probing %s failed: %s", path.virtual, exc)
        if refusal is not None and not isinstance(refusal, FileNotFoundError):
            errors.append(error_line(path, refusal, root))
            continue
        if opened_paths is not None and proved:
            # A streamed output's own write creates it; writing it nothing
            # first would cost the store a write (a PUT, a revision).
            opened_paths.append(path)
            continue
        try:
            await write_one(
                path, raw, parsed, read_stream, write_bytes, append_bytes
            )
            if opened_paths is not None:
                opened_paths.append(path)
        except PipeClosed:
            # A pipe operand whose reader has gone: SIGPIPE ends tee with
            # what it reported, unless -p or --output-error say otherwise.
            if parsed.pipe_errors is PipeErrors.SIGNAL:
                return None, IOResult(
                    exit_code=SIGPIPE_STATUS, stderr=b"".join(errors) or None
                )
            if parsed.pipe_errors is PipeErrors.REPORT:
                errors.append(
                    error_line(path, fs_error(path, FsCondition.EPIPE), root)
                )
                if parsed.stop_on_error:
                    break
        except Exception as exc:
            errors.append(error_line(path, exc, root))
            if parsed.stop_on_error:
                break
    if errors:
        return raw, IOResult(exit_code=1, stderr=b"".join(errors))
    return raw, IOResult()


async def tee_generic(
    paths: list[PathSpec],
    texts: list[str],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
    stat: StatFn | None = None,
    output_key: Callable[[PathSpec], str] | None = None,
    root: str = "",
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(flags or {})
    if stdin is not None and not isinstance(stdin, bytes):
        opened: list[PathSpec] = []
        _, io = await write_output(
            paths,
            b"",
            parsed,
            read_stream,
            write_bytes,
            append_bytes,
            stat,
            opened,
            root,
        )
        io.closed_stdout = _closed_stdout(parsed)
        if io.exit_code and parsed.stop_on_error:
            await close_quietly(stdin)
            return None, io
        return OutputStream(
            _tee_stream(
                stdin,
                opened,
                parsed,
                read_stream,
                write_bytes,
                append_bytes,
                io,
                output_key,
                root,
            ),
            partial(close_quietly, stdin),
        ), io
    raw = await read_stdin_async(stdin)
    if raw is None:
        raw = encode_text(" ".join(texts)) if texts else b""
    stdout: ByteSource | None = raw
    io = IOResult()
    if paths:
        stdout, io = await write_output(
            paths,
            raw,
            parsed,
            read_stream,
            write_bytes,
            append_bytes,
            stat,
            root=root,
        )
    io.closed_stdout = _closed_stdout(parsed)
    return stdout, io


async def _consume_output(
    path: PathSpec,
    parsed: TeeFlags,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None,
    source: ByteSource,
) -> None:
    if not parsed.append:
        await write_bytes(path, source)
    elif append_bytes is not None:
        await append_bytes(path, source)
    else:
        existing = b""
        try:
            existing = await materialize(read_stream(path))
        except FileNotFoundError as exc:
            logger.debug(
                "appending to a new file at %s: %s", path.virtual, exc
            )

        async def joined() -> AsyncIterator[bytes]:
            yield existing
            async with aclosing(chunks(source)) as stream:
                async for chunk in stream:
                    yield chunk

        await write_bytes(path, joined())


async def _tee_stream(
    source: ByteSource,
    paths: list[PathSpec],
    parsed: TeeFlags,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None,
    io: IOResult,
    output_key: Callable[[PathSpec], str] | None,
    root: str,
) -> AsyncIterator[bytes]:
    writers: dict[str, tuple[PathSpec, ByteWriter, int]] = {}
    errors = [await io.materialize_stderr()]

    def failed(path: PathSpec, exc: Exception) -> bool:
        if isinstance(exc, PipeClosed):
            if parsed.pipe_errors is PipeErrors.SIGNAL:
                io.exit_code = SIGPIPE_STATUS
                return True
            if parsed.pipe_errors is PipeErrors.IGNORE:
                return False
            exc = fs_error(path, FsCondition.EPIPE)
        errors.append(error_line(path, exc, root))
        io.exit_code = 1
        return parsed.stop_on_error

    for path in paths:
        key = output_key(path) if output_key is not None else path.virtual
        prior = writers.get(key)
        if prior is not None:
            writers[key] = (path, prior[1], prior[2] + int(parsed.append))
        else:
            writers[key] = (
                path,
                ByteWriter(
                    partial(
                        _consume_output,
                        path,
                        parsed,
                        read_stream,
                        write_bytes,
                        append_bytes,
                    )
                ),
                1,
            )

    async def feed(chunk: bytes) -> bool:
        for key, (path, writer, copies) in list(writers.items()):
            try:
                for _ in range(copies):
                    await writer.write(chunk)
            except Exception as exc:
                await writer.abort()
                del writers[key]
                if failed(path, exc):
                    return False
        return True

    cancelled = False
    try:
        async with aclosing(chunks(source)) as stream:
            # GNU's tee opens every output before it reads: a refused one
            # is reported (or ends it under exit) while the input is quiet.
            for key, (path, writer, _) in list(writers.items()):
                try:
                    await writer.opened()
                except Exception as exc:
                    await writer.abort()
                    del writers[key]
                    if failed(path, exc):
                        await close_quietly(source)
                        return
            try:
                async for chunk in stream:
                    if not await feed(chunk):
                        return
                    yield chunk
            except GeneratorExit:
                # stdout's reader left: GNU's tee goes on copying its input
                # to the files unless that ends it (SIGPIPE, or exit).
                if not (
                    parsed.pipe_errors is PipeErrors.SIGNAL
                    or (
                        parsed.pipe_errors is PipeErrors.REPORT
                        and parsed.stop_on_error
                    )
                ):
                    while writers:
                        rest = await anext(stream, None)
                        if rest is None or not await feed(rest):
                            break
                raise
    except (Exception, asyncio.CancelledError):
        cancelled = True
        raise
    finally:
        for path, writer, _ in writers.values():
            if cancelled:
                await writer.abort()
                continue
            try:
                await writer.finish()
            except Exception as exc:
                failed(path, exc)
        io.stderr = b"".join(errors) or None


def _closed_stdout(parsed: TeeFlags) -> ClosedPipe | None:
    """How tee answers its stdout's reader going away, as GNU's does under
    its ``PipeErrors`` mode.

    Args:
        parsed (TeeFlags): tee's flags.
    """
    if parsed.pipe_errors is PipeErrors.SIGNAL:
        return None
    if parsed.pipe_errors is PipeErrors.IGNORE:
        return ClosedPipe()
    phrase = posix_phrase(FsCondition.EPIPE)
    return ClosedPipe(
        stderr=encode_text(f"tee: 'standard output': {phrase}\n"),
        exit_code=1,
    )


__all__ = [
    "tee_generic",
    "parse_flags",
    "TeeFlags",
    "write_output",
    "write_one",
    "open_refusal",
    "error_line",
]
