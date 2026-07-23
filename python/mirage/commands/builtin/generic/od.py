import struct
from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def parse_count(value: str) -> int:
    multipliers = {
        "b": 512,
        "K": 1024,
        "KB": 1000,
        "M": 1024**2,
        "MB": 1000**2
    }
    suffix = next((key for key in sorted(multipliers, key=len, reverse=True)
                   if value.endswith(key)), "")
    return int(value[:-len(suffix)] if suffix else value, 0) * multipliers.get(
        suffix, 1)


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
            else:
                prefix = " " * 8 if address_radix != "n" else ""
            lines.append(prefix + _format_values(block, type_spec))
    final_address = _address(skip + len(data), address_radix)
    if final_address:
        lines.append(final_address)
    return ("\n".join(lines) + "\n").encode(), IOResult()


__all__ = ["od", "parse_count"]
