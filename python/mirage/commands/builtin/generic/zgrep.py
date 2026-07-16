import gzip as gziplib
import re
from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)
from dataclasses import dataclass
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (build_pattern_str,
                                                 resolve_pattern)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _read_plain(
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
) -> bytes:
    return await read_bytes(accessor, path)


def _zgrep_search(
    data: bytes,
    pattern: str,
    ignore_case: bool,
    invert: bool,
    count: bool,
    line_numbers: bool,
    filename: str | None,
    only_matching: bool,
    max_count: int | None,
) -> tuple[list[str], bool]:
    text = data.decode(errors="replace")
    lines = split_lines(text)
    flags = re.IGNORECASE if ignore_case else 0
    matched: list[tuple[int, str]] = []
    for idx, line in enumerate(lines, 1):
        if only_matching and not invert:
            hits = list(re.finditer(pattern, line, flags))
            if hits:
                for m in hits:
                    matched.append((idx, m.group()))
                    if max_count is not None and len(matched) >= max_count:
                        break
            elif invert:
                matched.append((idx, line))
        else:
            hit = bool(re.search(pattern, line, flags))
            if invert:
                hit = not hit
            if hit:
                matched.append((idx, line))
        if max_count is not None and len(matched) >= max_count:
            break
    if count:
        value = str(len(matched))
        if filename:
            value = f"{filename}:{value}"
        return [value], len(matched) > 0
    result: list[str] = []
    for idx, line in matched:
        prefix = ""
        if filename:
            prefix = filename + ":"
        if line_numbers:
            prefix += str(idx) + ":"
        result.append(prefix + line)
    return result, len(matched) > 0


def _files_only_match(data: bytes, pattern: str, ignore_case: bool,
                      invert: bool) -> bool:
    text = data.decode(errors="replace")
    flags = re.IGNORECASE if ignore_case else 0
    for line in split_lines(text):
        hit = bool(re.search(pattern, line, flags))
        if invert:
            hit = not hit
        if hit:
            return True
    return False


@dataclass(frozen=True, slots=True)
class ZgrepFlags:
    """Parsed zgrep flags; the complete set zgrep honors."""
    ignore_case: bool
    invert: bool
    count: bool
    files_only: bool
    line_numbers: bool
    fixed: bool
    force_filename: bool
    suppress_filename: bool
    only_matching: bool
    quiet: bool
    whole_word: bool
    max_count: int | None


def parse_flags(fl: FlagView, never_match: bool) -> ZgrepFlags:
    """Convert the raw flag bag into ZgrepFlags, the only string-keyed reads.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        never_match (bool): zero-pattern sentinel from resolve_pattern; it is
            a regex, so it suppresses -F.
    """
    return ZgrepFlags(
        ignore_case=fl.as_bool("i"),
        invert=fl.as_bool("v"),
        count=fl.as_bool("c"),
        files_only=fl.as_bool("args_l"),
        line_numbers=fl.as_bool("n"),
        fixed=fl.as_bool("F") and not never_match,
        force_filename=fl.as_bool("H"),
        suppress_filename=fl.as_bool("h"),
        only_matching=fl.as_bool("o"),
        quiet=fl.as_bool("q"),
        whole_word=fl.as_bool("w"),
        max_count=fl.as_int("m"),
    )


async def zgrep(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, object] | None = None,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["zgrep"])
    pattern, never_match = await resolve_pattern(
        texts, fl, partial(_read_plain, read_bytes), accessor, index,
        "zgrep: usage: zgrep [flags] pattern [path]")
    f = parse_flags(fl, never_match)
    compiled = build_pattern_str(pattern, f.fixed, f.whole_word)
    multi = len(paths) > 1
    show_filename = f.force_filename or (multi and not f.suppress_filename)
    any_match = False
    all_results: list[str] = []

    if paths:
        for p in paths:
            raw = await read_bytes(accessor, p)
            data = gziplib.decompress(raw)
            fname = p.virtual if show_filename else None
            if f.files_only:
                if _files_only_match(data, compiled, f.ignore_case, f.invert):
                    all_results.append(p.virtual)
                    any_match = True
            else:
                result, had_match = _zgrep_search(data, compiled,
                                                  f.ignore_case, f.invert,
                                                  f.count, f.line_numbers,
                                                  fname, f.only_matching,
                                                  f.max_count)
                if had_match:
                    any_match = True
                all_results.extend(result)
    else:
        stdin_raw = await _read_stdin_async(stdin)
        data = gziplib.decompress(stdin_raw) if stdin_raw else b""
        if f.files_only:
            if _files_only_match(data, compiled, f.ignore_case, f.invert):
                all_results.append("(standard input)")
                any_match = True
        else:
            result, had_match = _zgrep_search(data, compiled, f.ignore_case,
                                              f.invert, f.count,
                                              f.line_numbers, None,
                                              f.only_matching, f.max_count)
            if had_match:
                any_match = True
            all_results.extend(result)

    if f.quiet:
        return None, IOResult(exit_code=0 if any_match else 1)
    exit_code = 0 if any_match else 1
    if not all_results:
        return None, IOResult(exit_code=exit_code)
    return ("\n".join(all_results) +
            "\n").encode(), IOResult(exit_code=exit_code)


__all__ = ["zgrep"]
