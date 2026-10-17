import base64 as b64lib
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import INTMAX
from mirage.commands.builtin.utils.operands import split_readable
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.builtin.utils.strtol import xstrtoimax
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, ReadStreamFn, StatFn

ALPHABET = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
# GNU base64's line length when -w names none.
WRAP_WIDTH = 76


async def _base64_encode_stream(
    source: AsyncIterator[bytes], wrap: int | None
) -> AsyncIterator[bytes]:
    width = WRAP_WIDTH if wrap is None else wrap
    pending = b""
    column = 0
    stream = chunks(source)
    try:
        while True:
            chunk = await anext(stream, None)
            data = pending + (chunk or b"")
            size = len(data) if chunk is None else len(data) // 3 * 3
            encoded = b64lib.b64encode(data[:size])
            pending = data[size:]
            output: list[bytes] = []
            offset = 0
            while offset < len(encoded):
                take = (
                    min(len(encoded) - offset, width - column)
                    if width
                    else len(encoded)
                )
                output.append(encoded[offset : offset + take])
                offset += take
                column += take
                if width and column == width:
                    output.append(b"\n")
                    column = 0
            if output:
                yield b"".join(output)
            if chunk is None:
                break
        if width and column:
            yield b"\n"
    finally:
        await stream.aclose()


async def _base64_decode_stream(
    source: AsyncIterator[bytes], ignore_garbage: bool, io: IOResult
) -> AsyncIterator[bytes]:
    # GNU coreutils 9.7 accepts unpadded tails and concatenated padded
    # blocks. Decode as bytes arrive so an invalid suffix keeps its prefix.
    digits = 0
    value = 0
    padding = False
    stream = chunks(source)
    try:
        async for chunk in stream:
            output = bytearray()
            failed = False
            for byte in chunk:
                digit = ALPHABET.find(byte)
                if byte == 10 or (ignore_garbage and digit < 0 and byte != 61):
                    continue
                if padding:
                    if byte != 61:
                        failed = True
                        break
                    padding = False
                elif digit >= 0:
                    value = (value << 6) | digit
                    digits += 1
                    if digits >= 2:
                        output.append((value >> (2 * (4 - digits))) & 255)
                    if digits == 4:
                        digits, value = 0, 0
                elif byte == 61 and digits in (2, 3):
                    if value & ((1 << (2 * (4 - digits))) - 1):
                        failed = True
                        break
                    padding = digits == 2
                    digits, value = 0, 0
                else:
                    failed = True
                    break
            if failed:
                io.exit_code, io.stderr = 1, b"base64: invalid input\n"
            if output:
                yield bytes(output)
            if failed:
                return
        if (
            padding
            or digits == 1
            or (digits and value & ((1 << (2 * (4 - digits))) - 1))
        ):
            io.exit_code, io.stderr = 1, b"base64: invalid input\n"
    finally:
        await stream.aclose()


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
    if wrap is not None and wrap < 0:
        return None, IOResult(
            exit_code=1,
            stderr=f"base64: invalid wrap size: '{wrap}'\n".encode(),
        )
    if paths:
        source: AsyncIterator[bytes] = stdin_stream(read_stream, stdin)(
            paths[0]
        )
    else:
        source = resolve_source(stdin)

    if decode:
        io = IOResult()
        return _base64_decode_stream(source, ignore_garbage, io), io
    return _base64_encode_stream(source, wrap=wrap), IOResult()


__all__ = ["base64_cmd"]


def _wrap_refusal(text: str, value: int | None) -> str:
    """base64's refusal of a -w value that is no number or negative.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    return f"base64: invalid wrap size: '{quote_text(text)}'"


@dataclass(frozen=True, slots=True)
class Base64Flags:
    decode: bool = False
    wrap: int | None = None
    ignore_garbage: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> Base64Flags:
    fl = FlagView(flags, spec=SPECS["base64"])
    # GNU 9.7 reads -w with xstrtoimax and takes a width past intmax_t
    # as no wrapping at all.
    wrap = fl.as_number("wrap", xstrtoimax, _wrap_refusal, low=0)
    return Base64Flags(
        decode=fl.as_bool("D") or fl.as_bool("decode"),
        wrap=None if wrap is None else (0 if wrap > INTMAX else wrap),
        ignore_garbage=fl.as_bool("ignore_garbage"),
    )


async def base64_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
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
        ctx (Context): Flags and stdin from the dispatcher.
        read_stream (ReadStreamFn): Bound reader called as
            ``read_stream(path)``.
        stat (StatFn): Bound stat called as ``stat(path)``.
    """
    parsed = parse_flags(ctx.flags)
    if len(paths) == 1:
        _, err = await split_readable(paths, stdin_stat(stat), "base64")
        if err:
            return None, IOResult(exit_code=1, stderr=err)
    return await base64_cmd(
        paths,
        read_stream=read_stream,
        stdin=ctx.stdin,
        decode=parsed.decode,
        wrap=parsed.wrap,
        ignore_garbage=parsed.ignore_garbage,
    )
