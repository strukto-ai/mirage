import gzip as gziplib
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.grep_offsets import (decode_line, line_offsets,
                                                  match_offset, prefix_of)
from mirage.commands.builtin.grep_pattern import (build_pattern_str,
                                                  resolve_pattern)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# zgrep's hint takes the backtick form rather than the
# ``Try '... --help' for more information.`` line usage_hint builds, so
# it is a constant here rather than a call. A host zgrep prefixes a
# script line number and an interpreter path; both are dropped, since
# they name a file mirage does not have.
ZGREP_NO_PATTERN = "zgrep: missing pattern; try `zgrep --help' for help"


async def _read_plain(
    read_bytes: Callable[..., Awaitable[bytes]],
    path: PathSpec,
) -> bytes:
    return await read_bytes(path)


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
    byte_offsets: bool = False,
) -> tuple[list[str], bool]:
    """The lines zgrep prints for one decompressed input.

    Args:
        data (bytes): the decompressed input.
        pattern (str): the compiled pattern's source.
        ignore_case (bool): -i.
        invert (bool): -v.
        count (bool): -c, answer with the count alone.
        line_numbers (bool): -n.
        filename (str | None): the label each line carries, if any.
        only_matching (bool): -o.
        max_count (int | None): -m.
        byte_offsets (bool): -b, the byte offset of each line's start
            or, under -o, of the match itself, in the field order GNU
            grep prints (name, line, byte).
    """
    lines = split_lines(decode_line(data))
    offsets = line_offsets(lines) if byte_offsets else []
    flags = re.IGNORECASE if ignore_case else 0
    matched: list[tuple[int, int, str]] = []
    for idx, line in enumerate(lines, 1):
        start = offsets[idx - 1] if byte_offsets else 0
        if only_matching and not invert:
            hits = list(re.finditer(pattern, line, flags))
            if hits:
                for m in hits:
                    matched.append((idx, match_offset(start, line,
                                                      m.start()), m.group()))
                    if max_count is not None and len(matched) >= max_count:
                        break
            elif invert:
                matched.append((idx, start, line))
        else:
            hit = bool(re.search(pattern, line, flags))
            if invert:
                hit = not hit
            if hit:
                matched.append((idx, start, line))
        if max_count is not None and len(matched) >= max_count:
            break
    if count:
        value = str(len(matched))
        if filename:
            value = f"{filename}:{value}"
        return [value], len(matched) > 0
    result: list[str] = []
    for idx, offset, line in matched:
        prefix = filename + ":" if filename else ""
        prefix += prefix_of(idx if line_numbers else None,
                            offset if byte_offsets else None)
        result.append(prefix + line)
    return result, len(matched) > 0


def _files_only_match(data: bytes, pattern: str, ignore_case: bool,
                      invert: bool) -> bool:
    text = decode_line(data)
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
    files_without_match: bool
    line_numbers: bool
    byte_offsets: bool
    fixed: bool
    basic_regexp: bool
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
    # -l and -L set one mode in grep, so the later one on the line wins.
    listing: str | None = None
    for name in fl.typed_order("args_l", "files_without_match"):
        if fl.as_bool(name):
            listing = name
    return ZgrepFlags(
        ignore_case=fl.as_bool("i"),
        invert=fl.as_bool("v"),
        count=fl.as_bool("c"),
        files_only=listing == "args_l",
        files_without_match=listing == "files_without_match",
        line_numbers=fl.as_bool("n"),
        byte_offsets=fl.as_bool("byte_offset"),
        fixed=fl.as_bool("F") and not never_match,
        # zgrep is grep over decompressed bytes, so it reads a basic
        # expression unless -E says otherwise; -G asks for the default.
        basic_regexp=not fl.as_bool("E"),
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
    flags: Mapping[str, FlagValue] | None = None,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["zgrep"])
    pattern, never_match = await resolve_pattern(
        texts, fl, partial(_read_plain, read_bytes), ZGREP_NO_PATTERN)
    f = parse_flags(fl, never_match)
    compiled = build_pattern_str(pattern, f.fixed, f.whole_word,
                                 f.basic_regexp)
    multi = len(paths) > 1
    show_filename = f.force_filename or (multi and not f.suppress_filename)
    any_match = False
    all_results: list[str] = []

    if paths:
        for p in paths:
            raw = await read_bytes(p)
            data = gziplib.decompress(raw)
            fname = p.raw_path if show_filename else None
            if f.files_only or f.files_without_match:
                # -m0 selects no line at all, so -l lists nothing and -L
                # lists every archive, exit 1 (zgrep 3.11).
                matched = f.max_count != 0 and _files_only_match(
                    data, compiled, f.ignore_case, f.invert)
                # -L lists the files that selected nothing; the status
                # still follows the matching, as GNU grep's does.
                if matched == f.files_only:
                    all_results.append(p.raw_path)
                any_match = any_match or matched
            else:
                result, had_match = _zgrep_search(data, compiled,
                                                  f.ignore_case, f.invert,
                                                  f.count, f.line_numbers,
                                                  fname, f.only_matching,
                                                  f.max_count, f.byte_offsets)
                if had_match:
                    any_match = True
                all_results.extend(result)
    else:
        stdin_raw = await read_stdin_async(stdin)
        data = gziplib.decompress(stdin_raw) if stdin_raw else b""
        if f.files_only or f.files_without_match:
            matched = f.max_count != 0 and _files_only_match(
                data, compiled, f.ignore_case, f.invert)
            if matched == f.files_only:
                all_results.append("(standard input)")
            any_match = any_match or matched
        else:
            # GNU zgrep labels stdin "(standard input)" under -H.
            stdin_name = "(standard input)" if f.force_filename else None
            result, had_match = _zgrep_search(data, compiled, f.ignore_case,
                                              f.invert, f.count,
                                              f.line_numbers, stdin_name,
                                              f.only_matching, f.max_count,
                                              f.byte_offsets)
            if had_match:
                any_match = True
            all_results.extend(result)

    if f.quiet:
        return None, IOResult(exit_code=0 if any_match else 1)
    exit_code = 0 if any_match else 1
    if not all_results:
        return None, IOResult(exit_code=exit_code)
    return format_records(all_results), IOResult(exit_code=exit_code)


__all__ = ["zgrep"]
