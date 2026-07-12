import binascii
import re
from collections.abc import AsyncIterator, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _xxd_dump_stream(source: AsyncIterator[bytes], cols: int, group: int,
                           uppercase: bool) -> AsyncIterator[bytes]:
    fmt = "{:02X}" if uppercase else "{:02x}"
    offset_fmt = "{:08X}: " if uppercase else "{:08x}: "
    offset = 0
    leftover = b""
    async for chunk in source:
        data = leftover + chunk
        i = 0
        while i + cols <= len(data):
            row = data[i:i + cols]
            hex_parts: list[str] = []
            for g in range(0, len(row), group):
                hex_parts.append("".join(
                    fmt.format(b) for b in row[g:g + group]))
            hex_part = " ".join(hex_parts)
            ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
            line = offset_fmt.format(
                offset
            ) + f"{hex_part:<{cols * 2 + (cols // group) - 1}}  {ascii_part}\n"
            yield line.encode()
            offset += cols
            i += cols
        leftover = data[i:]
    if leftover:
        hex_parts = []
        for g in range(0, len(leftover), group):
            hex_parts.append("".join(
                fmt.format(b) for b in leftover[g:g + group]))
        hex_part = " ".join(hex_parts)
        ascii_part = "".join(
            chr(b) if 32 <= b < 127 else "." for b in leftover)
        line = offset_fmt.format(
            offset
        ) + f"{hex_part:<{cols * 2 + (cols // group) - 1}}  {ascii_part}\n"
        yield line.encode()


async def _xxd_plain_stream(source: AsyncIterator[bytes],
                            uppercase: bool) -> AsyncIterator[bytes]:
    async for chunk in source:
        h = binascii.hexlify(chunk)
        yield h.upper() if uppercase else h
    yield b"\n"


def _reverse_line(line: str) -> bytes:
    if ":" in line:
        line = line.split(":", 1)[1]
    parts = re.split(r"  +", line, maxsplit=1)
    hex_part = parts[0].replace(" ", "")
    if not hex_part:
        return b""
    try:
        return binascii.unhexlify(hex_part)
    except binascii.Error:
        return b""


async def _xxd_reverse_stream(
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    buf = b""
    async for chunk in source:
        buf += chunk
    text = buf.decode(errors="replace")
    if ":" in text:
        for line in split_lines(text):
            if line:
                yield _reverse_line(line)
    else:
        cleaned = re.sub(r"\s+", "", text)
        yield binascii.unhexlify(cleaned) if cleaned else b""


async def _apply_limits(source: AsyncIterator[bytes], skip: int,
                        limit: int) -> AsyncIterator[bytes]:
    pos = 0
    remaining = limit
    async for chunk in source:
        chunk_len = len(chunk)
        if pos + chunk_len <= skip:
            pos += chunk_len
            continue
        if pos < skip:
            chunk = chunk[skip - pos:]
            pos = skip
        if remaining <= 0:
            break
        if len(chunk) > remaining:
            chunk = chunk[:remaining]
        yield chunk
        remaining -= len(chunk)
        pos += len(chunk)


async def xxd(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    reverse: bool = False,
    plain: bool = False,
    uppercase: bool = False,
    cols: int = 16,
    group: int = 2,
    skip: int = 0,
    limit: int = 0,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.XXD, paths[2].raw_path)
    cache: list[str] = []
    if paths:
        source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        cache = [paths[0].mount_path]
    else:
        source = _resolve_source(stdin)

    if skip or limit:
        if not limit:
            limit = 2**63
        source = _apply_limits(source, skip, limit)

    if reverse:
        return _xxd_reverse_stream(source), IOResult(cache=cache)
    if plain:
        return _xxd_plain_stream(source,
                                 uppercase=uppercase), IOResult(cache=cache)
    return _xxd_dump_stream(source,
                            cols=cols,
                            group=group,
                            uppercase=uppercase), IOResult(cache=cache)


__all__ = ["xxd"]
