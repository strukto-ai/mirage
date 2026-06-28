from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)
from dataclasses import dataclass
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.cache.read_through import (cache_aware_read_bytes,
                                       cache_aware_read_stream)
from mirage.commands.builtin.grep_helper import (  # yapf: disable
    compile_pattern, count_exit_stream, count_records_have_matches,
    grep_files_only, grep_lines, grep_recursive, grep_stream, resolve_pattern)
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
from mirage.utils.path import rebase_display


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
    a_ctx = fl.int("A")
    b_ctx = fl.int("B")
    c_ctx = fl.int("C")
    return GrepFlags(
        ignore_case=fl.bool("i"),
        invert=fl.bool("v"),
        line_numbers=fl.bool("n"),
        count_only=fl.bool("c"),
        files_only=fl.bool("args_l"),
        whole_word=fl.bool("w"),
        fixed_string=fl.bool("F") and not never_match,
        only_matching=fl.bool("o"),
        quiet=fl.bool("q"),
        recursive=fl.bool("r") or fl.bool("R"),
        max_count=fl.int("m"),
        after_context=a_ctx if a_ctx is not None else (c_ctx or 0),
        before_context=b_ctx if b_ctx is not None else (c_ctx or 0),
    )


async def grep(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, object] | None = None,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    scope_check: Callable[..., Awaitable[str | None]] | None = None,
    show_filename: bool = False,
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
        accessor (object): Backend accessor passed through wrapper helpers.
        stdin (AsyncIterator[bytes] | bytes | None): Input used when paths is
            empty.
        scope_check (Callable[..., Awaitable[str | None]] | None): Optional
            backend warning hook.
        show_filename (bool): Force filename prefixes on a single path,
            for callers that pre-expanded a multi-file scope.
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
        mount_prefix = paths[0].prefix
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

        scope_warning_str: str | None = None
        if scope_check is not None and not paths[0].resolved:
            scope_warning_str = await scope_check(rd, st, paths[0],
                                                  f.recursive)

        if f.files_only:
            warnings: list[str] = []
            if scope_warning_str:
                warnings.append(scope_warning_str)
            results: list[str] = []
            for p in paths:
                hits = await grep_files_only(
                    rd,
                    st,
                    rb,
                    p.original,
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
                results.extend(rebase_display(hits, p.original, p.display))
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
            if scope_warning_str:
                warnings.append(scope_warning_str)
            for p in paths:
                s = await st(p.original)
                if s.type == FileType.DIRECTORY:
                    res = await grep_recursive(
                        rd,
                        st,
                        rb,
                        p.original,
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
                    all_results.extend(
                        rebase_display(res, p.original, p.display))
                else:
                    data = split_lines(
                        (await rb(p.original)).decode(errors="replace"))
                    hits = grep_lines(p.display, data, pat, f.invert,
                                      f.line_numbers, f.count_only,
                                      f.files_only, f.only_matching,
                                      f.max_count)
                    if f.count_only and hits:
                        all_results.append(f"{p.display}:{hits[0]}")
                    else:
                        all_results.extend(f"{p.display}:{rl}" for rl in hits)
            stderr = format_optional_records(warnings)
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if f.count_only and not count_records_have_matches(all_results):
                return format_records(all_results), IOResult(exit_code=1,
                                                             stderr=stderr)
            return format_records(all_results), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, f.ignore_case, f.fixed_string,
                              f.whole_word)

        if len(paths) > 1 or show_filename:
            all_results = []
            multi_warnings: list[str] = []
            for p in paths:
                try:
                    s = await st(p.original)
                except FileNotFoundError:
                    multi_warnings.append(
                        f"grep: {p.display}: No such file or directory")
                    continue
                if s.type == FileType.DIRECTORY:
                    multi_warnings.append(f"grep: {p.display}: Is a directory")
                    continue
                data = split_lines((await
                                    rb(p.original)).decode(errors="replace"))
                hits = grep_lines(p.display, data, pat, f.invert,
                                  f.line_numbers, f.count_only, f.files_only,
                                  f.only_matching, f.max_count)
                if f.count_only:
                    if hits:
                        all_results.append(f"{p.display}:{hits[0]}")
                elif f.files_only:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{p.display}:{r}" for r in hits)
            stderr = format_optional_records(multi_warnings)
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if f.count_only and not count_records_have_matches(all_results):
                return format_records(all_results), IOResult(exit_code=1,
                                                             stderr=stderr)
            return format_records(all_results), IOResult(stderr=stderr)

        first_stat = await st(paths[0].original)
        if first_stat.type == FileType.DIRECTORY:
            stderr = f"grep: {paths[0].display}: Is a directory\n".encode()
            return b"", IOResult(exit_code=1, stderr=stderr)

        if read_stream is not None:
            source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        else:
            data = await rb(paths[0].original)
            source = _wrap_bytes(data)
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
