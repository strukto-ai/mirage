import random
from collections.abc import Awaitable, Callable

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
    stdin: ByteSource | None = None,
    count: int | None = None,
    echo: bool = False,
    zero_terminated: bool = False,
    with_replacement: bool = False,
    input_range: str | None = None,
    output: PathSpec | None = None,
    write_bytes: Callable[[PathSpec, bytes], Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    sep = "\x00" if zero_terminated else "\n"

    if input_range is not None:
        low_raw, separator, high_raw = input_range.partition("-")
        if not separator:
            raise ValueError(f"shuf: invalid input range: {input_range}")
        items = [
            str(value) for value in range(int(low_raw),
                                          int(high_raw) + 1)
        ]
        result = _sample(items, count, with_replacement)
        rendered = (sep.join(result) + sep).encode()
    elif echo:
        items = [p.mount_path for p in paths] if paths else list(texts)
        result = _sample(items, count, with_replacement)
        rendered = (sep.join(result) + sep).encode()
    elif paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            if zero_terminated:
                all_lines.extend(data.split("\x00"))
            else:
                all_lines.extend(split_lines(data))
        result = _sample(all_lines, count, with_replacement)
        rendered = (sep.join(result) + sep).encode()
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("shuf: missing operand")
        text = raw.decode(errors="replace")
        lines = text.split("\x00") if zero_terminated else split_lines(text)
        result = _sample(lines, count, with_replacement)
        rendered = (sep.join(result) + sep).encode()
    if output is not None:
        if write_bytes is None:
            raise ValueError("shuf: backend provides no write op")
        await write_bytes(output, rendered)
        return None, IOResult(writes={output.mount_path: rendered})
    return rendered, IOResult()


__all__ = ["shuf"]
