import re
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _expand_leading_tabs(text: str, tabsize: int) -> str:
    return re.sub(
        r"(?m)^\t+",
        lambda m: m.group().expandtabs(tabsize),
        text,
    )


async def expand(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    tabsize: int = 8,
    initial_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    expander = (_expand_leading_tabs
                if initial_only else lambda txt, ts: txt.expandtabs(ts))
    if paths:
        all_text: list[str] = []
        for p in paths:
            data = (await read_bytes(accessor, p)).decode(errors="replace")
            all_text.append(expander(data, tabsize))
        return "".join(all_text).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("expand: missing operand")
    text = raw.decode(errors="replace")
    return expander(text, tabsize).encode(), IOResult()


__all__ = ["expand"]
