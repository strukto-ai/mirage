import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

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
class ExpandFlags:
    tabsize: int = 8
    initial_only: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> ExpandFlags:
    fl = FlagView(flags, spec=SPECS["expand"])
    return ExpandFlags(
        tabsize=int(fl.as_str("tabs") or "8"),
        initial_only=fl.as_bool("initial"),
    )


def _expand_leading_tabs(text: str, tabsize: int) -> str:
    return re.sub(
        r"(?m)^[ \t]+",
        lambda m: m.group().expandtabs(tabsize),
        text,
    )


async def expand(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    tabsize: int = 8,
    initial_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    expander = (_expand_leading_tabs
                if initial_only else lambda txt, ts: txt.expandtabs(ts))
    if paths:
        all_text: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            all_text.append(expander(data, tabsize))
        return "".join(all_text).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("expand: missing operand")
    text = raw.decode(errors="replace")
    return expander(text, tabsize).encode(), IOResult()


async def expand_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run expand over resolved operands; mirrors expandGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by expand.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "expand")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await expand(readable,
                     read_bytes=materialized_read(stream),
                     stdin=opts.stdin,
                     tabsize=parsed.tabsize,
                     initial_only=parsed.initial_only), err)


__all__ = ["expand", "expand_generic"]
