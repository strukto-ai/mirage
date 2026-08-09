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


def parse_flags(flags: Mapping[str, FlagValue]) -> TeeFlags:
    # --output-error values are validated declaratively: the spec's
    # choices= makes the parser report any other value and the executor
    # refuse with GNU's ARGMATCH shape before tee runs.
    fl = FlagView(flags, spec=SPECS["tee"])
    return TeeFlags(append=fl.as_bool("append"))


async def write_output(
    write_bytes: Callable[..., Awaitable[None]],
    path: PathSpec,
    data: bytes,
    passthrough: ByteSource,
) -> tuple[ByteSource | None, IOResult]:
    try:
        await write_bytes(path, data)
    except OSError as exc:
        # GNU tee still copies stdin to stdout on a write error, prints a
        # diagnostic, and exits non-zero. With a single output sink the
        # --output-error modes (warn/exit/*-nopipe) collapse to this. A
        # recognized filesystem refusal reads like GNU (operand as typed,
        # shared strerror); anything else keeps its own message, which is
        # the only description of the cause a transport error has.
        if fs_strerror(exc) is not None:
            err = fs_error_line("tee", path, exc).encode()
        else:
            err = f"tee: {path.mount_path}: {exc}\n".encode()
        return passthrough, IOResult(exit_code=1, stderr=err)
    return passthrough, IOResult(writes={path.mount_path: data},
                                 cache=[path.mount_path])


async def tee(
    paths: list[PathSpec],
    texts: tuple[str, ...],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    parsed = parse_flags(flags or {})
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raw = (" ".join(texts)).encode() if texts else b""
    write_data = raw
    if parsed.append:
        try:
            existing = b""
            async for chunk in read_stream(paths[0]):
                existing += chunk
            write_data = existing + raw
        except FileNotFoundError:
            # GNU tee -a creates a missing file: append to empty.
            pass
    return await write_output(write_bytes, paths[0], write_data, raw)


__all__ = ["tee", "parse_flags", "TeeFlags", "write_output"]
