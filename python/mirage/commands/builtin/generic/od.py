import struct
from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.constants import (OD_COUNT_PATTERN,
                                               OD_OVERFLOW_UNITS,
                                               OD_SIZE_UNITS, UINTMAX)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.errors import UsageError
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def parse_count(value: str, flag: str) -> int:
    """GNU strtoumax-base-0 byte count for ``od -j``/``-N``.

    Args:
        value (str): the raw flag value, e.g. ``0x10``, ``010``, ``1K``.
        flag (str): the flag spelling used in error messages (``-j``/``-N``).
    """
    match = OD_COUNT_PATTERN.match(value)
    if match is None:
        raise UsageError(f"od: invalid {flag} argument '{value}'", 1)
    number, suffix = match.group(1), match.group(2)
    multiplier = (OD_SIZE_UNITS.get(suffix) or OD_OVERFLOW_UNITS.get(suffix))
    if suffix and multiplier is None:
        raise UsageError(f"od: invalid suffix in {flag} argument '{value}'", 1)
    if number[:2].lower() == "0x":
        base = 16
    elif number.startswith("0") and len(number) > 1:
        base = 8
    else:
        base = 10
    count = int(number, base) * (multiplier or 1)
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
        13: "\\r"
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
        item = data[offset:offset + size]
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


async def od(
    paths: list[PathSpec],
    *,
    read_stream: Callable[[PathSpec], AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    address_radix: str = "o",
    skip: int = 0,
    limit: int | None = None,
    formats: list[str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    # od defines multiple FILE operands as one concatenated input, so skip
    # and limit offsets apply across the whole run, not per file.
    chunks: list[bytes] = []
    if paths:
        for p in paths:
            chunks.extend([chunk async for chunk in read_stream(p)])
    else:
        chunks.extend([chunk async for chunk in _resolve_source(stdin)])
    raw = b"".join(chunks)
    data = raw[skip:skip + limit if limit is not None else None]
    type_specs = formats or ["o2"]
    lines: list[str] = []
    for offset in range(0, len(data), 16):
        block = data[offset:offset + 16]
        for index, type_spec in enumerate(type_specs):
            address = _address(skip +
                               offset, address_radix) if index == 0 else ""
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
        return b"", IOResult()
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["od", "parse_count"]
