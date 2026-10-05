import base64 as b64lib
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import split_readable
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec, ReadStreamFn, StatFn


async def _base64_encode_stream(
    source: AsyncIterator[bytes], wrap: int | None
) -> AsyncIterator[bytes]:
    buf = b""
    async for chunk in source:
        buf += chunk
    encoded = b64lib.b64encode(buf).decode()
    if not encoded:
        return
    if wrap is not None and wrap == 0:
        yield encode_text(encoded) + b"\n"
        return
    line_len = wrap if wrap is not None else 76
    lines: list[str] = []
    for i in range(0, len(encoded), line_len):
        lines.append(encoded[i : i + line_len])
    yield encode_text("\n".join(lines)) + b"\n"


async def _base64_decode_stream(
    source: AsyncIterator[bytes], ignore_garbage: bool
) -> AsyncIterator[bytes]:
    buf = b""
    async for chunk in source:
        buf += chunk
    text = b"".join(buf.split())
    yield b64lib.b64decode(text, validate=not ignore_garbage)


async def base64_cmd(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    decode: bool = False,
    wrap: int | None = None,
    ignore_garbage: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 1:
        raise extra_operand_error(
            CommandName.BASE64, paths[1].raw_path or paths[1].virtual
        )
    cache: list[str] = []
    if paths:
        source: AsyncIterator[bytes] = stdin_stream(read_stream, stdin)(
            paths[0]
        )
        cache = [] if is_stdin(paths[0]) else [paths[0].mount_path]
    else:
        source = resolve_source(stdin)

    if decode:
        return _base64_decode_stream(source, ignore_garbage), IOResult(
            cache=cache
        )
    return _base64_encode_stream(source, wrap=wrap), IOResult(cache=cache)


__all__ = ["base64_cmd"]


@dataclass(frozen=True, slots=True)
class Base64Flags:
    decode: bool = False
    wrap: int | None = None
    ignore_garbage: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> Base64Flags:
    fl = FlagView(flags, spec=SPECS["base64"])
    wrap_value = fl.as_str("wrap")
    return Base64Flags(
        decode=fl.as_bool("D") or fl.as_bool("decode"),
        wrap=int(wrap_value) if wrap_value is not None else None,
        ignore_garbage=fl.as_bool("ignore_garbage"),
    )


async def base64_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_stream: ReadStreamFn,
    stat: StatFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run base64 over its one operand, GNU semantics; mirrors base64Generic.

    The operand is stat'ed before the lazy encode starts, so a missing or
    unreadable one is reported in base64's own words (``base64: nope: No
    such file or directory``) instead of surfacing mid-drain.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by base64.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        read_stream (ReadStreamFn): Bound reader called as
            ``read_stream(path)``.
        stat (StatFn): Bound stat called as ``stat(path)``.
    """
    parsed = parse_flags(opts.flags)
    if len(paths) == 1:
        _, err = await split_readable(paths, stdin_stat(stat), "base64")
        if err:
            return None, IOResult(exit_code=1, stderr=err)
    return await base64_cmd(
        paths,
        read_stream=read_stream,
        stdin=opts.stdin,
        decode=parsed.decode,
        wrap=parsed.wrap,
        ignore_garbage=parsed.ignore_garbage,
    )
