import gzip as gziplib
import re
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _build_pattern(pattern: str, fixed: bool, whole_word: bool) -> str:
    if fixed:
        pattern = re.escape(pattern)
    if whole_word:
        pattern = r"\b" + pattern + r"\b"
    return pattern


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
    lines = text.splitlines()
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
        return [str(len(matched))], len(matched) > 0
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
    for line in text.splitlines():
        hit = bool(re.search(pattern, line, flags))
        if invert:
            hit = not hit
        if hit:
            return True
    return False


async def zgrep(
    paths: list[PathSpec],
    *,
    pattern: str,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    ignore_case: bool = False,
    invert: bool = False,
    count: bool = False,
    files_only: bool = False,
    line_numbers: bool = False,
    extended: bool = False,
    fixed: bool = False,
    force_filename: bool = False,
    suppress_filename: bool = False,
    max_count: int | None = None,
    only_matching: bool = False,
    quiet: bool = False,
    whole_word: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    compiled = _build_pattern(pattern, fixed, whole_word)
    multi = len(paths) > 1
    show_filename = force_filename or (multi and not suppress_filename)
    any_match = False
    all_results: list[str] = []

    if paths:
        for p in paths:
            raw = await read_bytes(accessor, p)
            data = gziplib.decompress(raw)
            fname = p.original if show_filename else None
            if files_only:
                if _files_only_match(data, compiled, ignore_case, invert):
                    all_results.append(p.original)
                    any_match = True
            else:
                result, had_match = _zgrep_search(data, compiled, ignore_case,
                                                  invert, count, line_numbers,
                                                  fname, only_matching,
                                                  max_count)
                if had_match:
                    any_match = True
                all_results.extend(result)
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("zgrep: missing input")
        data = gziplib.decompress(raw)
        if files_only:
            if _files_only_match(data, compiled, ignore_case, invert):
                all_results.append("(standard input)")
                any_match = True
        else:
            result, had_match = _zgrep_search(data, compiled, ignore_case,
                                              invert, count, line_numbers,
                                              None, only_matching, max_count)
            if had_match:
                any_match = True
            all_results.extend(result)

    if quiet:
        return None, IOResult(exit_code=0 if any_match else 1)
    if not any_match:
        return None, IOResult(exit_code=1)
    return ("\n".join(all_results) + "\n").encode(), IOResult()


__all__ = ["zgrep"]
