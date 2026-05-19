from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.sort_helper import _sort_key
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _dedupe(lines: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for ln in lines:
        if ln not in seen:
            seen.add(ln)
            out.append(ln)
    return out


async def sort(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    reverse: bool = False,
    numeric: bool = False,
    unique: bool = False,
    fold_case: bool = False,
    key_field: int | None = None,
    field_separator: str | None = None,
    human_numeric: bool = False,
    version_sort: bool = False,
    month_sort: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(accessor, p)).decode(errors="replace")
            all_lines.extend(data.splitlines())
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("sort: missing operand")
        all_lines = raw.decode(errors="replace").splitlines()

    all_lines.sort(
        key=lambda x:
        _sort_key(x, key_field, field_separator, fold_case, numeric,
                  human_numeric, version_sort, month_sort),
        reverse=reverse,
    )
    if unique:
        all_lines = _dedupe(all_lines)
    output = "\n".join(all_lines)
    return (output + "\n").encode() if output else b"", IOResult()


__all__ = ["sort"]
