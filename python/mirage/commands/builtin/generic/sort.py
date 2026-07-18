from collections.abc import Awaitable, Callable

from mirage.commands.builtin.sort_helper import _sort_key, _unique_key
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sort(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    reverse: bool = False,
    numeric: bool = False,
    unique: bool = False,
    fold_case: bool = False,
    key_field: int | None = None,
    field_separator: str | None = None,
    human_numeric: bool = False,
    version_sort: bool = False,
    month_sort: bool = False,
    ignore_blanks: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            all_lines.extend(split_lines(data))
    else:
        raw = await _read_stdin_async(stdin)
        all_lines = split_lines((raw or b"").decode(errors="replace"))

    key_args = (key_field, field_separator, fold_case, numeric, human_numeric,
                version_sort, month_sort, ignore_blanks)
    all_lines.sort(key=lambda x: _sort_key(x, *key_args), reverse=reverse)
    if unique:
        seen: set[object] = set()
        deduped: list[str] = []
        for line in all_lines:
            dk = _unique_key(_sort_key(line, *key_args))
            if dk not in seen:
                seen.add(dk)
                deduped.append(line)
        all_lines = deduped
    output = "\n".join(all_lines)
    return (output + "\n").encode() if all_lines else b"", IOResult()


__all__ = ["sort"]
