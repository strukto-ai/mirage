from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class FoldFlags:
    width: int = 80
    break_spaces: bool = False
    count_bytes: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> FoldFlags:
    fl = FlagView(flags, spec=SPECS["fold"])
    return FoldFlags(
        width=int(fl.as_str("width") or "80"),
        break_spaces=fl.as_bool("spaces"),
        count_bytes=fl.as_bool("bytes"),
    )


def _fold_line(line: str, width: int, break_spaces: bool) -> str:
    if len(line) <= width:
        return line
    parts: list[str] = []
    while len(line) > width:
        if break_spaces:
            idx = line.rfind(" ", 0, width)
            if idx > 0:
                parts.append(line[:idx + 1])
                line = line[idx + 1:]
            else:
                parts.append(line[:width])
                line = line[width:]
        else:
            parts.append(line[:width])
            line = line[width:]
    if line:
        parts.append(line)
    return "\n".join(parts)


def _fold_bytes(data: bytes, width: int) -> bytes:
    lines = data.splitlines(keepends=True)
    output = bytearray()
    for line in lines:
        ending = b"\n" if line.endswith(b"\n") else b""
        body = line[:-1] if ending else line
        for offset in range(0, len(body), width):
            output.extend(body[offset:offset + width])
            if offset + width < len(body) or ending:
                output.extend(b"\n")
    return bytes(output)


async def fold(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    width: int = 80,
    break_spaces: bool = False,
    count_bytes: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        all_lines: list[str] = []
        for p in paths:
            raw = await read_bytes(p)
            if count_bytes:
                all_lines.append(
                    _fold_bytes(raw,
                                width).decode(errors="replace").rstrip("\n"))
                continue
            data = raw.decode(errors="replace")
            for line in split_lines(data):
                all_lines.append(_fold_line(line, width, break_spaces))
        return (("\n".join(all_lines) +
                 "\n").encode() if all_lines else b""), IOResult()

    stdin_raw = await _read_stdin_async(stdin)
    if stdin_raw is None:
        raise ValueError("fold: missing operand")
    if count_bytes:
        return _fold_bytes(stdin_raw, width), IOResult()
    lines = split_lines(stdin_raw.decode(errors="replace"))
    result = [_fold_line(ln, width, break_spaces) for ln in lines]
    return (("\n".join(result) + "\n").encode() if result else b""), IOResult()


async def fold_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run fold over resolved operands, GNU semantics; mirrors foldGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by fold.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "fold")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await fold(readable,
                   read_bytes=materialized_read(stream),
                   stdin=opts.stdin,
                   width=parsed.width,
                   break_spaces=parsed.break_spaces,
                   count_bytes=parsed.count_bytes), err)


__all__ = ["fold", "fold_generic"]
