import textwrap
from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _leading_spaces(line: str) -> str:
    return line[:len(line) - len(line.lstrip())]


def _format_paragraph(para: str, width: int, prefix: str | None,
                      split_only: bool, tagged: bool, crown: bool) -> str:
    lines = para.splitlines()
    if prefix is not None:
        if not lines or any(not line.startswith(prefix) for line in lines):
            return para
        lines = [line[len(prefix):] for line in lines]
    first_indent = _leading_spaces(lines[0]) if lines else ""
    body_indent = first_indent
    if (tagged or crown) and len(lines) > 1:
        body_indent = _leading_spaces(lines[1])
    wrapper = textwrap.TextWrapper(width=width,
                                   initial_indent=first_indent,
                                   subsequent_indent=body_indent,
                                   break_long_words=False,
                                   break_on_hyphens=False)
    if split_only:
        result = "\n".join(
            textwrap.fill(line.strip(),
                          width=width,
                          initial_indent=_leading_spaces(line),
                          subsequent_indent=_leading_spaces(line),
                          break_long_words=False,
                          break_on_hyphens=False) for line in lines)
    else:
        result = wrapper.fill(" ".join(line.strip() for line in lines))
    if prefix is not None:
        result = "\n".join(prefix + line for line in result.splitlines())
    return result


def _fmt_text(text: str, width: int, goal: int | None, prefix: str | None,
              split_only: bool, tagged: bool, crown: bool) -> str:
    target_width = min(width, goal) if goal is not None else width
    paragraphs = text.split("\n\n")
    formatted: list[str] = []
    for para in paragraphs:
        if para.strip():
            formatted.append(
                _format_paragraph(para, target_width, prefix, split_only,
                                  tagged, crown))
        else:
            formatted.append("")
    return "\n\n".join(formatted) + "\n"


async def fmt(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    width: int = 75,
    goal: int | None = None,
    prefix: str | None = None,
    split_only: bool = False,
    tagged: bool = False,
    crown: bool = False,
    uniform: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_text: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            all_text.append(data)
        return _fmt_text("".join(all_text), width, goal, prefix, split_only,
                         tagged, crown).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("fmt: missing operand")
    text = raw.decode(errors="replace")
    return _fmt_text(text, width, goal, prefix, split_only, tagged,
                     crown).encode(), IOResult()


__all__ = ["fmt"]
