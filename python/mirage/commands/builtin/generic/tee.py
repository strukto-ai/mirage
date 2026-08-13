from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import fs_error_line, fs_strerror


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
    return TeeFlags(append=fl.as_bool("append"),
                    stop_on_error=mode in ("exit", "exit-nopipe"))


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
        return fs_error_line("tee", path, exc).encode()
    return f"tee: {path.mount_path}: {exc}\n".encode()


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


async def write_output(
    paths: list[PathSpec],
    raw: bytes,
    parsed: TeeFlags,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None = None,
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

    Deliberate divergence: GNU opens every operand up front, so under
    ``exit`` an *open* failure aborts before any data is written. A mount
    has no open/write split — ``write_bytes`` is one call — so the
    operands before the failure are already written. The two agree
    whenever the failure is at write time, which is what a remote backend
    reports.

    Args:
        paths (list[PathSpec]): every output operand, in order.
        raw (bytes): what tee was handed, and what reaches stdout.
        parsed (TeeFlags): the parsed flags.
        read_stream (Callable): backend read, for the emulated append.
        write_bytes (Callable): backend whole-file write.
        append_bytes (Callable | None): backend native append, if wired.
    """
    writes: dict[str, ByteSource] = {}
    cache: list[str] = []
    errors: list[bytes] = []
    for path in paths:
        try:
            data = await write_one(path, raw, parsed, read_stream, write_bytes,
                                   append_bytes)
        except Exception as exc:
            errors.append(error_line(path, exc))
            if parsed.stop_on_error:
                break
            continue
        writes[path.mount_path] = raw if data is None else data
        if data is not None:
            cache.append(path.mount_path)
    if errors:
        return raw, IOResult(exit_code=1,
                             stderr=b"".join(errors),
                             writes=writes,
                             cache=cache)
    return raw, IOResult(writes=writes, cache=cache)


async def tee(
    paths: list[PathSpec],
    texts: list[str],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    append_bytes: Callable[..., Awaitable[None]] | None = None,
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    parsed = parse_flags(flags or {})
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raw = (" ".join(texts)).encode() if texts else b""
    return await write_output(paths, raw, parsed, read_stream, write_bytes,
                              append_bytes)


__all__ = [
    "tee", "parse_flags", "TeeFlags", "write_output", "write_one", "error_line"
]
