from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.formatting import _human_size
from mirage.types import PathSpec


def _format_size(size: int, human: bool) -> str:
    return _human_size(size) if human else str(size)


def _depth(entry_path: str, base_path: str) -> int:
    base = base_path.rstrip("/")
    rel = entry_path.rstrip("/")[len(base):]
    if not rel:
        return 0
    return rel.strip("/").count("/") + 1


async def _du_one(
    path: PathSpec,
    compute_total: Callable[[PathSpec], Awaitable[int]],
    compute_all: Callable[[PathSpec], Awaitable[tuple[list[tuple[str, int]],
                                                      int]]],
    *,
    s: bool,
    a: bool,
    h: bool,
    max_depth: int | None,
) -> tuple[str, int]:
    label = path.original

    if s:
        total = await compute_total(path)
        return _format_size(total, h) + "\t" + label, total

    all_entries, total = await compute_all(path)
    if not all_entries:
        total = await compute_total(path)
        return _format_size(total, h) + "\t" + label, total

    if not a:
        return _format_size(total, h) + "\t" + label, total

    entries = all_entries
    if max_depth is not None:
        entries = [(p, sz) for p, sz in entries
                   if _depth(p, label) <= max_depth]
    if not entries:
        return _format_size(total, h) + "\t" + label, total

    lines = [_format_size(sz, h) + "\t" + p for p, sz in entries]
    display_total = sum(sz for _, sz in entries)
    return "\n".join(lines), display_total


async def du(
    paths: list[PathSpec],
    *,
    compute_total: Callable[[PathSpec], Awaitable[int]],
    compute_all: Callable[[PathSpec], Awaitable[tuple[list[tuple[str, int]],
                                                      int]]],
    s: bool = False,
    a: bool = False,
    h: bool = False,
    max_depth: int | None = None,
    c: bool = False,
) -> str:
    sub_texts: list[str] = []
    totals: list[int] = []
    for p in paths:
        text, total = await _du_one(
            p,
            compute_total,
            compute_all,
            s=s,
            a=a,
            h=h,
            max_depth=max_depth,
        )
        sub_texts.append(text)
        totals.append(total)
    out = "\n".join(sub_texts)
    if c:
        grand = sum(totals)
        out += "\n" + _format_size(grand, h) + "\ttotal"
    return out
