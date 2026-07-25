from collections.abc import Awaitable, Callable

from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec

_UNITS = {
    "K": 1024,
    "KB": 1000,
    "M": 1024**2,
    "MB": 1000**2,
    "G": 1024**3,
    "GB": 1000**3,
    "T": 1024**4,
    "TB": 1000**4,
}


def parse_size(value: str, current: int) -> int:
    operation = value[:1] if value[:1] in {"+", "-", "<", ">", "/", "%"
                                           } else ""
    raw = value[1:] if operation else value
    suffix = next((unit for unit in sorted(_UNITS, key=len, reverse=True)
                   if raw.endswith(unit)), "")
    number = int(raw[:-len(suffix)] if suffix else raw) * _UNITS.get(suffix, 1)
    if operation == "+":
        return current + number
    if operation == "-":
        return max(0, current - number)
    if operation == "<":
        return min(current, number)
    if operation == ">":
        return max(current, number)
    if operation == "/":
        return current - current % number
    if operation == "%":
        return ((current + number - 1) // number) * number
    return number


async def truncate(
    paths: list[PathSpec],
    *,
    size: str,
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    truncate_fn: Callable[[PathSpec, int], Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("truncate: missing file operand")
    for path in paths:
        current = (await stat(path)).size or 0
        await truncate_fn(path, parse_size(size, current))
    return None, IOResult()


__all__ = ["parse_size", "truncate"]
