import textwrap
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _fmt_text(text: str, width: int) -> str:
    paragraphs = text.split("\n\n")
    formatted = []
    for para in paragraphs:
        para = para.strip()
        if para:
            formatted.append(
                textwrap.fill(para,
                              width=width,
                              break_long_words=False,
                              break_on_hyphens=False))
        else:
            formatted.append("")
    return "\n\n".join(formatted) + "\n"


async def fmt(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    width: int = 75,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_text: list[str] = []
        for p in paths:
            data = (await read_bytes(accessor, p)).decode(errors="replace")
            all_text.append(data)
        return _fmt_text("".join(all_text), width).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("fmt: missing operand")
    text = raw.decode(errors="replace")
    return _fmt_text(text, width).encode(), IOResult()


__all__ = ["fmt"]
