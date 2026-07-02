from collections.abc import Awaitable, Callable

from mirage.commands.builtin.utils.formatting import _human_size
from mirage.commands.builtin.utils.output import (format_record_text,
                                                  format_records)
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
    label = path.display

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
                   if _depth(p, path.virtual) <= max_depth]
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
    out = format_record_text(sub_texts)
    if c:
        grand = sum(totals)
        out += _format_size(grand, h) + "\ttotal\n"
    return out


async def _du_block(
    p0: PathSpec,
    compute_total: Callable[[PathSpec], Awaitable[int]],
    compute_all: Callable[[PathSpec], Awaitable[list[tuple[str, int]]]] | None,
    *,
    s: bool,
    a: bool,
    h: bool,
    max_depth: int | None,
) -> tuple[list[str], int]:
    if s or compute_all is None:
        total = await compute_total(p0)
        return [_format_size(total, h) + "\t" + p0.display], total
    all_entries = await compute_all(p0)
    if not all_entries:
        total = await compute_total(p0)
        return [_format_size(total, h) + "\t" + p0.display], total
    if not a:
        all_entries = [(p, sz) for p, sz in all_entries if p == p0.virtual]
    if max_depth is not None:
        all_entries = [(p, sz) for p, sz in all_entries
                       if _depth(p, p0.virtual) <= max_depth]
    if not all_entries:
        total = await compute_total(p0)
        return [_format_size(total, h) + "\t" + p0.display], total
    lines = [_format_size(sz, h) + "\t" + p for p, sz in all_entries]
    return lines, sum(sz for _, sz in all_entries)


async def du_multi(
    paths: list[PathSpec],
    *,
    compute_total: Callable[[PathSpec], Awaitable[int]],
    compute_all: Callable[[PathSpec], Awaitable[list[tuple[str, int]]]]
    | None = None,
    h: bool = False,
    s: bool = False,
    a: bool = False,
    max_depth: int | None = None,
    c: bool = False,
) -> bytes:
    lines: list[str] = []
    totals: list[int] = []
    for p0 in paths:
        block, total = await _du_block(p0,
                                       compute_total,
                                       compute_all,
                                       s=s,
                                       a=a,
                                       h=h,
                                       max_depth=max_depth)
        lines.extend(block)
        totals.append(total)
    if c:
        lines.append(_format_size(sum(totals), h) + "\ttotal")
    return format_records(lines)
