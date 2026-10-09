import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.generic.decompress import decompress_inputs
from mirage.commands.builtin.grep_binary import valid_utf8
from mirage.commands.builtin.grep_offsets import prefix_of
from mirage.commands.builtin.grep_pattern import (
    NEVER_MATCH,
    compile_pattern,
    matcher_syntax,
    pattern_warnings,
    resolve_pattern,
)
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.constants import STDIN_OPERAND
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.links import LinkResolver
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.pcre import match_start, match_text
from mirage.commands.builtin.utils.stream import operand_label
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.shell.bytes import byte_view, decode_text, encode_text, text_view
from mirage.types import PathSpec, StatFn


async def _read_plain(
    read_bytes: Callable[..., Awaitable[bytes]],
    path: PathSpec,
) -> bytes:
    return await read_bytes(path)


def _zgrep_search(
    data: bytes,
    pattern: re.Pattern[str],
    invert: bool,
    count: bool,
    line_numbers: bool,
    filename: str | None,
    only_matching: bool,
    max_count: int | None,
    byte_offsets: bool = False,
    utf8: bool = False,
) -> tuple[list[str], bool, bool]:
    """The lines zgrep prints for one decompressed input.

    Under a UTF-8 locale a line or match to print that holds a byte no
    character owns is binary output, which grep leaves out and reports
    once the input is done; the third value says whether any was.

    Args:
        data (bytes): the decompressed input.
        pattern (re.Pattern[str]): the matcher grep compiles, -i folded in.
        invert (bool): -v.
        count (bool): -c, answer with the count alone.
        line_numbers (bool): -n.
        filename (str | None): the label each line carries, if any.
        only_matching (bool): -o.
        max_count (int | None): -m.
        byte_offsets (bool): -b, the byte offset of each line's start
            or, under -o, of the match itself, in the field order GNU
            grep prints (name, line, byte). A line is matched as its
            byte view, so its length is already its byte count.
        utf8 (bool): match characters rather than bytes, counting each
            one's bytes for -b.
    """
    matched: list[tuple[int, int, str]] = []
    start = 0
    for idx, line in enumerate(split_lines(byte_view(data, utf8)), 1):
        if only_matching and not invert:
            hits = list(pattern.finditer(line))
            if hits:
                for m in hits:
                    at = match_start(m)
                    matched.append(
                        (
                            idx,
                            start
                            + (len(encode_text(line[:at])) if utf8 else at),
                            match_text(m),
                        )
                    )
                    if max_count is not None and len(matched) >= max_count:
                        break
        else:
            hit = bool(pattern.search(line))
            if invert:
                hit = not hit
            if hit:
                matched.append((idx, start, line))
        if max_count is not None and len(matched) >= max_count:
            break
        start += len(encode_text(line) if utf8 else line) + 1
    if count:
        value = str(len(matched))
        if filename:
            value = f"{filename}:{value}"
        return [value], len(matched) > 0, False
    result: list[str] = []
    binary = False
    for idx, offset, line in matched:
        if utf8 and not valid_utf8(encode_text(line)):
            binary = True
            continue
        prefix = filename + ":" if filename else ""
        prefix += prefix_of(
            idx if line_numbers else None, offset if byte_offsets else None
        )
        result.append(prefix + text_view(line, utf8))
    return result, len(matched) > 0, binary


def _files_only_match(
    data: bytes, pattern: re.Pattern[str], invert: bool, utf8: bool = False
) -> bool:
    text = byte_view(data, utf8)
    for line in split_lines(text):
        hit = bool(pattern.search(line))
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
    syntax: RegexSyntax
    force_filename: bool
    suppress_filename: bool
    only_matching: bool
    quiet: bool
    whole_word: bool
    line_regexp: bool
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
        # expression unless -E or -P says otherwise, and refuses two
        # matchers as grep does; -G asks for the default.
        syntax=matcher_syntax(fl, "grep", "P"),
        force_filename=fl.as_bool("H"),
        suppress_filename=fl.as_bool("h"),
        only_matching=fl.as_bool("o"),
        quiet=fl.as_bool("q"),
        whole_word=fl.as_bool("w"),
        line_regexp=fl.as_bool("line_regexp"),
        max_count=fl.as_int("m"),
    )


async def zgrep_generic(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, FlagValue] | None = None,
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    stat: StatFn | None = None,
    resolver: LinkResolver | None = None,
    utf8: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["zgrep"])
    pattern, never_match = await resolve_pattern(
        texts,
        fl,
        partial(_read_plain, read_bytes),
        "zgrep: usage: zgrep [flags] pattern [path]",
    )
    f = parse_flags(fl, never_match)
    # GNU grep 3.11 skips regex validation and selection under -m0.
    compiled = (
        None
        if f.max_count == 0
        else re.compile(NEVER_MATCH)
        if never_match
        else compile_pattern(
            byte_view(pattern, utf8),
            f.ignore_case,
            f.fixed,
            f.whole_word,
            f.syntax,
            utf8,
            f.line_regexp,
        )
    )
    multi = len(paths) > 1
    show_filename = f.force_filename or (multi and not f.suppress_filename)
    any_match = False
    all_results: list[str] = []

    # zgrep runs grep, so grep's compile warnings come first, in its name.
    errors: list[str] = (
        []
        if compiled is None or never_match or f.fixed
        else [pattern_warnings(pattern, f.syntax).decode()]
    )
    failed = False
    for p in paths or [STDIN_OPERAND]:
        # zgrep decompresses each operand with `gzip -cdfq -- FILE`,
        # which reports its own failures and hands grep what it decoded.
        body, io = await decompress_inputs(
            [p],
            read=read_bytes,
            stdin=stdin,
            to_stdout=True,
            force=True,
            quiet=True,
            stat=stat,
            resolver=resolver,
        )
        data = await materialize(body)
        errors.append(decode_text(await io.materialize_stderr()))
        failed = failed or io.exit_code == 1
        if compiled is None:
            if f.files_without_match:
                all_results.append(p.raw_path)
            continue
        # zgrep hands grep a stdin operand as `-`, so -l and -L list it
        # as `-` while its lines are labelled `(standard input)` (gzip
        # 1.13); /dev/stdin is named as typed either way.
        fname = operand_label(p, "(standard input)") if show_filename else None
        if f.files_only or f.files_without_match:
            matched = _files_only_match(data, compiled, f.invert, utf8)
            # -L lists the files that selected nothing; the status
            # still follows the matching, as GNU grep's does.
            if matched == f.files_only:
                all_results.append(p.raw_path)
            any_match = any_match or matched
        else:
            result, had_match, binary = _zgrep_search(
                data,
                compiled,
                f.invert,
                f.count,
                f.line_numbers,
                fname,
                f.only_matching,
                f.max_count,
                f.byte_offsets,
                utf8,
            )
            if had_match:
                any_match = True
            all_results.extend(result)
            if binary and not f.quiet:
                label = operand_label(p, "(standard input)")
                errors.append(f"grep: {label}: binary file matches\n")

    # gzip's failure is exit 2 even beside a match, -q included (zgrep
    # 1.13 takes the more serious status of gzip's and grep's per file).
    exit_code = 2 if failed else 0 if any_match else 1
    stderr = encode_text("".join(errors)) or None
    # Under -m0, GNU still prints -L's operands even with -q.
    if (f.quiet and f.max_count != 0) or not all_results:
        return None, IOResult(exit_code=exit_code, stderr=stderr)
    return format_records(all_results), IOResult(
        exit_code=exit_code, stderr=stderr
    )


__all__ = ["zgrep_generic"]
