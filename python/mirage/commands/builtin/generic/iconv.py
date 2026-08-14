from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def iconv(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    from_enc: str = "utf-8",
    to_enc: str = "utf-8",
    ignore_errors: bool = False,
    output_path: PathSpec | None = None,
) -> tuple[ByteSource | None, IOResult]:
    err_mode = "ignore" if ignore_errors else "strict"
    if paths:
        raw = await read_bytes(paths[0])
    else:
        stdin_raw = await _read_stdin_async(stdin)
        raw = stdin_raw if stdin_raw is not None else b""
    decoded = raw.decode(from_enc, errors=err_mode)
    encoded = decoded.encode(to_enc, errors=err_mode)
    if output_path is not None:
        await write_bytes(output_path, encoded)
        return None, IOResult(writes={output_path.mount_path: encoded})
    return encoded, IOResult()


__all__ = ["iconv"]


@dataclass(frozen=True, slots=True)
class IconvFlags:
    from_enc: str = "utf-8"
    to_enc: str = "utf-8"
    ignore_errors: bool = False
    output_path: PathSpec | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> IconvFlags:
    fl = FlagView(flags, spec=SPECS["iconv"])
    output = fl.raw("o")
    return IconvFlags(
        from_enc=fl.as_str("f") or "utf-8",
        to_enc=fl.as_str("t") or "utf-8",
        ignore_errors=fl.as_bool("c"),
        output_path=output if isinstance(output, PathSpec) else None,
    )


async def iconv_generic(paths, texts, opts: CommandOpts, read_bytes,
                        write_bytes):
    parsed = parse_flags(opts.flags)
    return await iconv(paths,
                       read_bytes=read_bytes,
                       write_bytes=write_bytes,
                       stdin=opts.stdin,
                       from_enc=parsed.from_enc,
                       to_enc=parsed.to_enc,
                       ignore_errors=parsed.ignore_errors,
                       output_path=parsed.output_path)
