import errno
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.paths import (
    absent_dest_strerror,
    entry_kind,
)
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.fs import fs_strerror
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, StatFn

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class TeeFlags:
    append: bool = False
    stop_on_error: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> TeeFlags:
    # --output-error values are validated declaratively: the spec's
    # choices= makes the parser report any other value and the executor
    # refuse with GNU's ARGMATCH shape before tee runs. Only the exit/
    # warn axis is observable here: the -nopipe half distinguishes a pipe
    # sink from a file sink, and every operand tee writes is a file.
    # A bare --output-error means warn (GNU 9.7).
    fl = FlagView(flags, spec=SPECS["tee"])
    mode = fl.as_str("output_error")
    return TeeFlags(
        append=fl.as_bool("append"),
        stop_on_error=mode in ("exit", "exit-nopipe"),
    )


def error_line(path: PathSpec, exc: Exception) -> bytes:
    """GNU's diagnostic for one unwritable operand.

    A recognized filesystem refusal reads like GNU (operand as typed,
    shared strerror); anything else keeps its own message, which is the
    only description of the cause a transport error has.

    Args:
        path (PathSpec): the operand that could not be written.
        exc (Exception): the refusal.
    """
    if fs_strerror(exc) is not None:
        return encode_text(fs_error_line("tee", path, exc))
    return encode_text(f"tee: {path.mount_path}: {exc}\n")


async def write_one(
    path: PathSpec,
    raw: bytes,
    parsed: TeeFlags,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None,
) -> bytes | None:
    """Write one operand, returning its new content when that is known.

    ``None`` means "written, but the resulting bytes are not in hand" —
    the native append case. The caller then lists the path in ``writes``
    without listing it in ``cache``, which is how ``apply_io`` is told to
    drop the stale entry instead of caching a wrong one. That costs one
    read on the next access and saves reading and re-uploading the whole
    object on this one.

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
        return raw
    if append_bytes is not None:
        await append_bytes(path, raw)
        return None
    existing = b""
    try:
        async for chunk in read_stream(path):
            existing += chunk
    except FileNotFoundError:
        # GNU tee -a creates a missing file: append to empty.
        pass
    data = existing + raw
    await write_bytes(path, data)
    return data


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
        return NotADirectoryError(errno.ENOTDIR, os.strerror(errno.ENOTDIR))
    exists, is_dir = await entry_kind(stat, path)
    if is_dir:
        return IsADirectoryError(errno.EISDIR, os.strerror(errno.EISDIR))
    if exists:
        return None
    strerror = await absent_dest_strerror(stat, path)
    if strerror is None:
        return None
    if strerror == os.strerror(errno.ENOTDIR):
        return NotADirectoryError(errno.ENOTDIR, strerror)
    return FileNotFoundError(errno.ENOENT, strerror)


async def write_output(
    paths: list[PathSpec],
    raw: bytes,
    parsed: TeeFlags,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None = None,
    stat: StatFn | None = None,
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
    """
    writes: dict[str, ByteSource] = {}
    cache: list[str] = []
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
                if prior.mount_path in opened:
                    continue
                try:
                    if not (
                        parsed.append and (await entry_kind(stat, prior))[0]
                    ):
                        await write_bytes(prior, b"")
                        writes[prior.mount_path] = b""
                        cache.append(prior.mount_path)
                except Exception as exc:
                    failed, refusal = prior, exc
                    break
                opened.add(prior.mount_path)
            if refusal is None:
                try:
                    data = await write_one(
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
                    writes[path.mount_path] = b"" if data is None else data
                    opened.add(path.mount_path)
                    continue
            return None, IOResult(
                exit_code=1,
                stderr=error_line(failed, refusal),
                writes=writes,
                cache=cache,
            )
    for index, path in enumerate(paths):
        # A store keeps a key over a directory or under a file, where an
        # open would fail, so the open is probed for every output, not
        # only the ones --output-error=exit probed above.
        refusal = None
        if stat is not None and not parsed.stop_on_error:
            try:
                refusal = await open_refusal(stat, path, paths[:index])
            except Exception as exc:
                logger.debug("tee: probing %s failed: %s", path.virtual, exc)
        if refusal is not None and not isinstance(refusal, FileNotFoundError):
            errors.append(error_line(path, refusal))
            continue
        try:
            data = await write_one(
                path, raw, parsed, read_stream, write_bytes, append_bytes
            )
        except Exception as exc:
            errors.append(error_line(path, exc))
            if parsed.stop_on_error:
                break
            continue
        writes[path.mount_path] = raw if data is None else data
        if data is not None and path.mount_path not in cache:
            cache.append(path.mount_path)
    if errors:
        return raw, IOResult(
            exit_code=1, stderr=b"".join(errors), writes=writes, cache=cache
        )
    return raw, IOResult(writes=writes, cache=cache)


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
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(flags or {})
    raw = await read_stdin_async(stdin)
    if raw is None:
        raw = encode_text(" ".join(texts)) if texts else b""
    if not paths:
        return raw, IOResult()
    return await write_output(
        paths, raw, parsed, read_stream, write_bytes, append_bytes, stat
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
