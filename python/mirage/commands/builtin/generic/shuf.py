import random
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _sample(items: list[str], count: int | None,
            with_replacement: bool) -> list[str]:
    if with_replacement:
        n = count if count is not None else len(items)
        return random.choices(items, k=n) if items else []
    out = list(items)
    random.shuffle(out)
    if count is not None:
        out = out[:count]
    return out


async def shuf(
    paths: list[PathSpec],
    texts: tuple[str, ...],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    count: int | None = None,
    echo: bool = False,
    zero_terminated: bool = False,
    with_replacement: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    sep = "\x00" if zero_terminated else "\n"

    if echo:
        items = [p.strip_prefix for p in paths] if paths else list(texts)
        result = _sample(items, count, with_replacement)
        return (sep.join(result) + sep).encode(), IOResult()

    if paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(accessor, p)).decode(errors="replace")
            if zero_terminated:
                all_lines.extend(data.split("\x00"))
            else:
                all_lines.extend(split_lines(data))
        result = _sample(all_lines, count, with_replacement)
        return (sep.join(result) + sep).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("shuf: missing operand")
    text = raw.decode(errors="replace")
    lines = text.split("\x00") if zero_terminated else split_lines(text)
    result = _sample(lines, count, with_replacement)
    return (sep.join(result) + sep).encode(), IOResult()


__all__ = ["shuf"]
