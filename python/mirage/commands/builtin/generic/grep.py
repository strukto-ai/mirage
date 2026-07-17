from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)
from dataclasses import dataclass
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.cache.read_through import (cache_aware_read_bytes,
                                       cache_aware_read_stream)
from mirage.commands.builtin.grep_helper import (  # yapf: disable
    compile_pattern, count_exit_stream, count_records_have_matches,
    grep_files_only, grep_lines, grep_recursive, grep_stream, prefix_lines,
    resolve_pattern)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.stream import exit_on_empty, quiet_match
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import rebase_raw


@dataclass(frozen=True, slots=True)
class GrepFlags:
    """Parsed grep flags (TS FlagSet parity); the complete set grep honors."""
    ignore_case: bool
    invert: bool
    line_numbers: bool
    count_only: bool
    files_only: bool
    whole_word: bool
    fixed_string: bool
    only_matching: bool
    quiet: bool
    recursive: bool
    with_filename: bool
    no_filename: bool
    max_count: int | None
    after_context: int
    before_context: int


def parse_flags(fl: FlagView, never_match: bool) -> GrepFlags:
    """Convert the raw flag bag into GrepFlags, the only string-keyed reads.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        never_match (bool): zero-pattern sentinel from resolve_pattern; it is
            a regex, so it suppresses -F.
    """
    a_ctx = fl.as_int("A")
    b_ctx = fl.as_int("B")
    c_ctx = fl.as_int("C")
    return GrepFlags(
        ignore_case=fl.as_bool("i"),
        invert=fl.as_bool("v"),
        line_numbers=fl.as_bool("n"),
        count_only=fl.as_bool("c"),
        files_only=fl.as_bool("args_l"),
        whole_word=fl.as_bool("w"),
        fixed_string=fl.as_bool("F") and not never_match,
        only_matching=fl.as_bool("o"),
        quiet=fl.as_bool("q"),
        recursive=fl.as_bool("r") or fl.as_bool("R"),
        with_filename=fl.as_bool("H"),
        no_filename=fl.as_bool("h"),
        max_count=fl.as_int("m"),
        after_context=a_ctx if a_ctx is not None else (c_ctx or 0),
        before_context=b_ctx if b_ctx is not None else (c_ctx or 0),
    )


async def grep(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, object] | None = None,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run grep-style fallback search over backend paths or stdin.

    Interprets the raw flag kwargs itself (TS grepGeneric parity), so
    backend wrappers only wire paths, texts, flags, and backend I/O.

    Args:
        paths (list[PathSpec]): Backend paths to search. Empty paths consume
            stdin.
        texts (Sequence[str]): positional TEXT operands (the pattern unless
            -e/-f supplied it).
        flags (Mapping[str, object] | None): raw flag kwargs from the
            dispatcher (e, f, i, v, n, c, args_l, w, F, o, q, r, R, m,
            A, B, C).
        readdir (Callable[..., Awaitable[list[str]]]): Directory reader.
        stat (Callable[[PathSpec], Awaitable[FileStat]]): Backend stat reader.
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader.
        read_stream (Callable[..., AsyncIterator[bytes]] | None): Optional
            stream reader.
        accessor (Accessor | None): Backend accessor passed through wrapper
            helpers.
        stdin (AsyncIterator[bytes] | bytes | None): Input used when paths is
            empty.
        index (IndexCacheStore | None): Optional cache index for wrapped
            backend calls.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    read_bytes = cache_aware_read_bytes(read_bytes)
    if read_stream is not None:
        read_stream = cache_aware_read_stream(read_stream)
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern, never_match = await resolve_pattern(
        texts, fl, read_bytes, accessor, index,
        "grep: usage: grep [flags] pattern [path]")
    f = parse_flags(fl, never_match)

    if paths:
        mount_prefix = mount_prefix_of(paths[0].virtual,
                                       paths[0].resource_path)
        rd = partial(call_readdir,
                     readdir,
                     accessor,
                     index=index,
                     prefix=mount_prefix)
        st = partial(call_stat,
                     stat,
                     accessor,
                     index=index,
                     prefix=mount_prefix)
        rb = partial(call_read_bytes,
                     read_bytes,
                     accessor,
                     index=index,
                     prefix=mount_prefix)

        if f.files_only:
            warnings: list[str] = []
            results: list[str] = []
            for p in paths:
                hits = await grep_files_only(
                    rd,
                    st,
                    rb,
                    p.virtual,
                    pattern,
                    recursive=f.recursive,
                    ignore_case=f.ignore_case,
                    invert=f.invert,
                    line_numbers=f.line_numbers,
                    count_only=f.count_only,
                    fixed_string=f.fixed_string,
                    only_matching=f.only_matching,
                    max_count=f.max_count,
                    whole_word=f.whole_word,
                    warnings=warnings,
                    read_stream_fn=None,
                )
                results.extend(rebase_raw(hits, p.virtual, p.raw_path))
            stderr = format_optional_records(warnings)
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return format_records(results), IOResult(stderr=stderr)

        if f.recursive:
            pat = compile_pattern(pattern, f.ignore_case, f.fixed_string,
                                  f.whole_word)
            # OPTIMIZATION (see #207): this buffers every match into
            # all_results and returns it materialized, so
            # `grep -r PATTERN dir | head -n 3`
            # still scans the whole tree before head sees a line. For plain
            # line output (not -c/-l, which must aggregate) this could instead
            # yield prefixed matches lazily per file as an async generator
            # wrapped in exit_on_empty, letting an early-exiting consumer
            # (head, grep -m, grep -q) abort the walk after enough matches.
            all_results: list[str] = []
            warnings = []
            for p in paths:
                s = await st(p.virtual)
                if s.type == FileType.DIRECTORY:
                    res = await grep_recursive(
                        rd,
                        st,
                        rb,
                        p.virtual,
                        pat,
                        invert=f.invert,
                        line_numbers=f.line_numbers,
                        count_only=f.count_only,
                        files_only=False,
                        only_matching=f.only_matching,
                        max_count=f.max_count,
                        warnings=warnings,
                        read_stream_fn=None,
                    )
                    all_results.extend(rebase_raw(res, p.virtual, p.raw_path))
                else:
                    data = split_lines(
                        (await rb(p.virtual)).decode(errors="replace"))
                    hits = grep_lines(p.raw_path, data, pat, f.invert,
                                      f.line_numbers, f.count_only,
                                      f.files_only, f.only_matching,
                                      f.max_count)
                    label = "" if f.no_filename else f"{p.raw_path}:"
                    if f.count_only and hits:
                        all_results.append(f"{label}{hits[0]}")
                    else:
                        all_results.extend(f"{label}{rl}" for rl in hits)
            stderr = format_optional_records(warnings)
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if f.count_only and not count_records_have_matches(all_results):
                return format_records(all_results), IOResult(exit_code=1,
                                                             stderr=stderr)
            return format_records(all_results), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, f.ignore_case, f.fixed_string,
                              f.whole_word)

        if len(paths) > 1:
            all_results = []
            multi_warnings: list[str] = []
            for p in paths:
                try:
                    s = await st(p.virtual)
                except FileNotFoundError:
                    multi_warnings.append(
                        f"grep: {p.raw_path}: No such file or directory")
                    continue
                if s.type == FileType.DIRECTORY:
                    multi_warnings.append(
                        f"grep: {p.raw_path}: Is a directory")
                    continue
                data = split_lines((await
                                    rb(p.virtual)).decode(errors="replace"))
                hits = grep_lines(p.raw_path, data, pat, f.invert,
                                  f.line_numbers, f.count_only, f.files_only,
                                  f.only_matching, f.max_count)
                label = "" if f.no_filename else f"{p.raw_path}:"
                if f.count_only:
                    if hits:
                        all_results.append(f"{label}{hits[0]}")
                elif f.files_only:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{label}{r}" for r in hits)
            stderr = format_optional_records(multi_warnings)
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if f.count_only and not count_records_have_matches(all_results):
                return format_records(all_results), IOResult(exit_code=1,
                                                             stderr=stderr)
            return format_records(all_results), IOResult(stderr=stderr)

        first_stat = await st(paths[0].virtual)
        if first_stat.type == FileType.DIRECTORY:
            stderr = f"grep: {paths[0].raw_path}: Is a directory\n".encode()
            return b"", IOResult(exit_code=1, stderr=stderr)

        if read_stream is not None:
            source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        else:
            raw_bytes = await rb(paths[0].virtual)
            source = _wrap_bytes(raw_bytes)
        stream = grep_stream(
            source,
            pat,
            invert=f.invert,
            line_numbers=f.line_numbers,
            only_matching=f.only_matching,
            max_count=f.max_count,
            count_only=f.count_only,
            after_context=f.after_context,
            before_context=f.before_context,
        )
        if f.quiet:
            io = IOResult(exit_code=1)
            return quiet_match(stream, io), io
        io = IOResult()
        out = (count_exit_stream(stream, io)
               if f.count_only else exit_on_empty(stream, io))
        if f.with_filename and not (f.after_context or f.before_context):
            # GNU labels context lines with `-` instead of `:`, which the
            # uniform prefix cannot reproduce, so -H skips context output.
            out = prefix_lines(out, f"{paths[0].raw_path}:")
        return out, io

    source = _resolve_source(stdin,
                             "grep: usage: grep [flags] pattern [path]",
                             error_cls=UsageError)
    pat = compile_pattern(pattern, f.ignore_case, f.fixed_string, f.whole_word)
    stream = grep_stream(
        source,
        pat,
        invert=f.invert,
        line_numbers=f.line_numbers,
        only_matching=f.only_matching,
        max_count=f.max_count,
        count_only=f.count_only,
        after_context=f.after_context,
        before_context=f.before_context,
    )
    if f.quiet:
        io = IOResult(exit_code=1)
        return quiet_match(stream, io), io
    io = IOResult()
    if f.count_only:
        return count_exit_stream(stream, io), io
    return exit_on_empty(stream, io), io


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


__all__ = ["grep"]
