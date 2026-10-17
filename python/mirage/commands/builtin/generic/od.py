import struct
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.constants import (
    OD_OVERFLOW_UNITS,
    OD_SIZE_UNITS,
    UINTMAX,
    XSTRTOUMAX_PATTERN,
)
from mirage.commands.builtin.utils.size_suffix import parse_base0
from mirage.commands.builtin.utils.stream import resolve_source, stdin_stream
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec

SKIP_PAST_END = b"od: cannot skip past end of combined input\n"
RADIX_REFUSAL = (
    "od: invalid output address radix '{}'; it must be one character "
    "from [doxn]"
)


def parse_radix(value: str) -> str:
    """``-A`` as GNU od reads it: its first character, one of ``doxn``.

    An empty value is its terminating NUL, refused like any other
    character (GNU 9.7 prints the NUL between the quotes).

    Args:
        value (str): the raw flag value.
    """
    radix = value[:1] or "\0"
    if radix not in "doxn":
        raise UsageError(RADIX_REFUSAL.format(radix), 1)
    return radix


def parse_count(value: str, flag: str) -> int:
    """GNU strtoumax-base-0 byte count for ``od -j``/``-N``.

    Args:
        value (str): the raw flag value, e.g. ``0x10``, ``010``, ``1K``.
        flag (str): the flag spelling used in error messages (``-j``/``-N``).
    """
    match = XSTRTOUMAX_PATTERN.match(value)
    if match is None:
        raise UsageError(f"od: invalid {flag} argument '{value}'", 1)
    number, suffix = match.group(1), match.group(2)
    multiplier = OD_SIZE_UNITS.get(suffix) or OD_OVERFLOW_UNITS.get(suffix)
    if suffix and multiplier is None:
        raise UsageError(f"od: invalid suffix in {flag} argument '{value}'", 1)
    count = parse_base0(number) * (multiplier or 1)
    if count > UINTMAX:
        raise UsageError(f"od: {flag} argument '{value}' too large", 1)
    return count


def _address(offset: int, radix: str) -> str:
    if radix == "n":
        return ""
    if radix == "d":
        return f"{offset:07d}"
    if radix == "x":
        return f"{offset:07x}"
    return f"{offset:07o}"


def _char(byte: int) -> str:
    escapes = {
        0: "\\0",
        7: "\\a",
        8: "\\b",
        9: "\\t",
        10: "\\n",
        11: "\\v",
        12: "\\f",
        13: "\\r",
    }
    if byte in escapes:
        return escapes[byte]
    if 32 <= byte < 127:
        return chr(byte)
    return f"{byte:03o}"


def _format_values(data: bytes, type_spec: str) -> str:
    kind = type_spec[:1]
    size = int(type_spec[1:] or ("8" if kind == "f" else "2"))
    if kind in {"a", "c"}:
        return " ".join(f"{_char(byte):>3}" for byte in data)
    values: list[str] = []
    for offset in range(0, len(data), size):
        item = data[offset : offset + size]
        if len(item) < size:
            item = item.ljust(size, b"\0")
        if kind == "f":
            value = struct.unpack("<f" if size == 4 else "<d", item)[0]
            values.append(f"{value:.6g}")
            continue
        value = int.from_bytes(item, "little", signed=kind == "d")
        if kind == "x":
            values.append(f"{value:0{size * 2}x}")
        elif kind == "o":
            values.append(f"{value:0{(size * 8 + 2) // 3}o}")
        else:
            values.append(str(value))
    return " ".join(values)


async def _taken(
    source: AsyncIterator[bytes], skip: int, left: int | None
) -> tuple[list[bytes], int]:
    """One operand's bytes past ``skip`` and up to ``left``, the stream
    closed once the skip is spent and ``left`` are in.

    Args:
        source (AsyncIterator[bytes]): the operand's stream.
        skip (int): bytes still to skip.
        left (int | None): bytes still to keep, None for all.

    Returns:
        tuple[list[bytes], int]: the bytes kept and the skip left over.
    """
    kept: list[bytes] = []
    stream = chunks(source)
    try:
        async for chunk in stream:
            if skip:
                dropped = min(skip, len(chunk))
                chunk = chunk[dropped:]
                skip -= dropped
            if left is not None:
                chunk = chunk[:left]
                left -= len(chunk)
            if chunk:
                kept.append(chunk)
            if left == 0 and not skip:
                break
    finally:
        await stream.aclose()
    return kept, skip


async def _combined(
    paths: list[PathSpec],
    read: Callable[[PathSpec], AsyncIterator[bytes]],
    skip: int,
    limit: int | None,
) -> tuple[bytes, bytes, bool, int]:
    """The operands as od's one input, past ``skip`` and within ``limit``.

    As GNU od: an operand that cannot be opened is reported and passed
    over; one that fails to read (a directory) is reported, ends any
    skip, and counts as opened. Once the skip is spent and ``limit``
    bytes are in, no later operand is opened.

    Args:
        paths (list[PathSpec]): the operands.
        read (Callable): the operands' stream, stdin for ``-``.
        skip (int): -j.
        limit (int | None): -N.

    Returns:
        tuple[bytes, bytes, bool, int]: the bytes, the error lines,
        whether any operand opened, and the skip left unspent.
    """
    kept: list[bytes] = []
    err = b""
    opened = False
    left = limit
    for p in paths:
        if left == 0 and opened and not skip:
            break
        try:
            part, skip = await _taken(read(p), skip, left)
        except FS_ERRORS as exc:
            err += encode_text(fs_error_line("od", p, exc))
            if isinstance(exc, IsADirectoryError):
                opened = True
                skip = 0
            continue
        opened = True
        kept.extend(part)
        if left is not None:
            left -= sum(len(chunk) for chunk in part)
    return b"".join(kept), err, opened, skip


@dataclass(frozen=True, slots=True)
class OdFlags:
    address_radix: str = "o"
    skip: int = 0
    limit: int | None = None
    formats: tuple[str, ...] = ()


def parse_flags(flags: Mapping[str, FlagValue]) -> OdFlags:
    """od's options, read once and refused in GNU's order: -A, -j, -N.

    An explicitly empty value is read as typed, not as absent: GNU
    refuses ``od -N ''`` as an invalid argument.

    Args:
        flags (Mapping[str, FlagValue]): the line's parsed options.
    """
    fl = FlagView(flags, spec=SPECS["od"])
    formats = tuple(
        "c" if name == "c" else str(value)
        for name, value in fl.occurrences("format", "c")
    )
    radix = parse_radix(fl.as_str("address_radix", "o"))
    skip = fl.as_str("skip_bytes")
    limit = fl.as_str("read_bytes")
    return OdFlags(
        address_radix=radix,
        skip=0 if skip is None else parse_count(skip, "-j"),
        limit=None if limit is None else parse_count(limit, "-N"),
        formats=formats,
    )


async def od_generic(
    paths: list[PathSpec],
    ctx: Context,
    *,
    read_stream: Callable[[PathSpec], AsyncIterator[bytes]],
) -> tuple[ByteSource | None, IOResult]:
    """Dump the operands, GNU od semantics; mirrors odGeneric.

    od defines multiple FILE operands as one concatenated input, so skip
    and limit offsets apply across the whole run, not per file.

    Args:
        paths (list[PathSpec]): the operands, empty for stdin.
        ctx (Context): the line's options and input.
        read_stream (Callable): bound reader, ``read_stream(path)``.
    """
    parsed = parse_flags(ctx.flags)
    stdin = ctx.stdin
    address_radix = parsed.address_radix
    skip, limit = parsed.skip, parsed.limit
    if paths:
        data, err, opened, unspent = await _combined(
            paths,
            stdin_stream(read_stream, stdin, sole=True),
            skip,
            limit,
        )
    else:
        kept, unspent = await _taken(resolve_source(stdin), skip, limit)
        data, err, opened = b"".join(kept), b"", True
    if unspent:
        return None, IOResult(exit_code=1, stderr=err + SKIP_PAST_END)
    io = IOResult(exit_code=1 if err else 0, stderr=err or None)
    if not opened:
        return None, io
    type_specs = list(parsed.formats) or ["o2"]
    lines: list[str] = []
    for offset in range(0, len(data), 16):
        block = data[offset : offset + 16]
        for index, type_spec in enumerate(type_specs):
            address = (
                _address(skip + offset, address_radix) if index == 0 else ""
            )
            if address:
                prefix = f"{address} "
            elif address_radix == "n":
                # GNU prints every value as " %s", so a suppressed address
                # column still leaves one leading space per line.
                prefix = " "
            else:
                prefix = " " * 8
            lines.append(prefix + _format_values(block, type_spec))
    final_address = _address(skip + len(data), address_radix)
    if final_address:
        lines.append(final_address)
    if not lines:
        return b"", io
    return ("\n".join(lines) + "\n").encode(), io


__all__ = [
    "OdFlags",
    "od_generic",
    "parse_count",
    "parse_flags",
    "parse_radix",
]
