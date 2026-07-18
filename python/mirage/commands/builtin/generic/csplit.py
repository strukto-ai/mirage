import re
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _split_by_patterns(
    lines: list[str],
    patterns: list[str],
) -> list[list[str]]:
    parts: list[list[str]] = []
    current_start = 0
    for pat in patterns:
        if pat.startswith("/") and pat.endswith("/"):
            regex = pat[1:-1]
            for idx in range(current_start, len(lines)):
                if re.search(regex, lines[idx]):
                    parts.append(lines[current_start:idx])
                    current_start = idx
                    break
        else:
            line_num = int(pat)
            split_at = line_num - 1
            if split_at > current_start:
                parts.append(lines[current_start:split_at])
                current_start = split_at
    if current_start < len(lines):
        parts.append(lines[current_start:])
    return parts


async def csplit(
    paths: list[PathSpec],
    patterns: tuple[str, ...],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    stdin: ByteSource | None = None,
    prefix: str | PathSpec = "xx",
    digits: int = 2,
    suffix_format: str | None = None,
    keep_on_error: bool = False,
    silent: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if isinstance(prefix, PathSpec):
        prefix = prefix.mount_path
    suffix_fmt = suffix_format if suffix_format else f"%0{digits}d"
    if paths:
        raw = await read_bytes(paths[0])
    else:
        stdin_raw = await _read_stdin_async(stdin)
        raw = stdin_raw if stdin_raw is not None else b""
    text = raw.decode(errors="replace")
    lines = split_lines(text)
    parts = _split_by_patterns(lines, list(patterns))
    writes: dict[str, ByteSource] = {}
    sizes: list[str] = []
    try:
        for idx, part in enumerate(parts):
            filename = prefix + (suffix_fmt % idx)
            data = ("\n".join(part) + "\n").encode() if part else b""
            await write_bytes(PathSpec.from_str_path(filename), data)
            writes[filename] = data
            sizes.append(str(len(data)))
    except Exception:
        if not keep_on_error:
            raise
    output = "" if silent or not sizes else "\n".join(sizes) + "\n"
    return output.encode(), IOResult(writes=writes)


__all__ = ["csplit"]
