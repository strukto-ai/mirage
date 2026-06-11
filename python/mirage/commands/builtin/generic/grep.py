from collections.abc import AsyncIterator, Awaitable, Callable
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only, grep_lines,
                                                 grep_recursive, grep_stream)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.io.stream import exit_on_empty, quiet_match
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec


async def grep(
    paths: list[PathSpec],
    *,
    pattern: str,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    pattern_via_e: bool = False,
    ignore_case: bool = False,
    invert: bool = False,
    line_numbers: bool = False,
    count_only: bool = False,
    files_only: bool = False,
    whole_word: bool = False,
    fixed_string: bool = False,
    only_matching: bool = False,
    quiet: bool = False,
    recursive: bool = False,
    max_count: int | None = None,
    after_context: int = 0,
    before_context: int = 0,
    scope_check: Callable[..., Awaitable[str | None]] | None = None,
    show_filename: bool = False,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run grep-style fallback search over backend paths or stdin.

    Args:
        paths (list[PathSpec]): Backend paths to search. Empty paths consume
            stdin.
        pattern (str): Pattern text from CLI arguments.
        readdir (Callable[..., Awaitable[list[str]]]): Directory reader.
        stat (Callable[[PathSpec], Awaitable[FileStat]]): Backend stat reader.
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader.
        read_stream (Callable[..., AsyncIterator[bytes]] | None): Optional
            stream reader.
        accessor (object): Backend accessor passed through wrapper helpers.
        stdin (AsyncIterator[bytes] | bytes | None): Input used when paths is
            empty.
        pattern_via_e (bool): True when the pattern came from `-e`.
        ignore_case (bool): `-i`, case-insensitive matching.
        invert (bool): `-v`, select non-matching lines.
        line_numbers (bool): `-n`, prefix line numbers.
        count_only (bool): `-c`, output match counts.
        files_only (bool): `-l`, output only matching file paths.
        whole_word (bool): `-w`, match whole words.
        fixed_string (bool): `-F`, treat pattern as a literal string.
        only_matching (bool): `-o`, output only matched text.
        quiet (bool): `-q`, suppress stdout and use exit status only.
        recursive (bool): `-r`, descend into directories.
        max_count (int | None): `-m`, stop after this many matching lines.
        after_context (int): `-A`, trailing context lines.
        before_context (int): `-B`, leading context lines.
        scope_check (Callable[..., Awaitable[str | None]] | None): Optional
            backend warning hook.
        show_filename (bool): Force filename prefixes on a single path,
            for callers that pre-expanded a multi-file scope.
        index (IndexCacheStore | None): Optional cache index for wrapped
            backend calls.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
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
            scope_warning_str = await scope_check(rd, st, paths[0], recursive)

        if files_only:
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
                    recursive=recursive,
                    ignore_case=ignore_case,
                    invert=invert,
                    line_numbers=line_numbers,
                    count_only=count_only,
                    fixed_string=fixed_string,
                    only_matching=only_matching,
                    max_count=max_count,
                    whole_word=whole_word,
                    warnings=warnings,
                    read_stream_fn=None,
                )
                results.extend(hits)
            stderr = format_optional_records(warnings)
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return format_records(results), IOResult(stderr=stderr)

        if recursive:
            pat = compile_pattern(pattern, ignore_case, fixed_string,
                                  whole_word)
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
                        invert=invert,
                        line_numbers=line_numbers,
                        count_only=count_only,
                        files_only=False,
                        only_matching=only_matching,
                        max_count=max_count,
                        warnings=warnings,
                        read_stream_fn=None,
                    )
                    all_results.extend(res)
                else:
                    data = split_lines(
                        (await rb(p.original)).decode(errors="replace"))
                    hits = grep_lines(p.original, data, pat, invert,
                                      line_numbers, count_only, files_only,
                                      only_matching, max_count)
                    if count_only and hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                    else:
                        all_results.extend(f"{p.original}:{rl}" for rl in hits)
            stderr = format_optional_records(warnings)
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return format_records(all_results), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

        if len(paths) > 1 or show_filename:
            all_results = []
            multi_warnings: list[str] = []
            for p in paths:
                try:
                    s = await st(p.original)
                except FileNotFoundError:
                    multi_warnings.append(
                        f"grep: {p.original}: No such file or directory")
                    continue
                if s.type == FileType.DIRECTORY:
                    multi_warnings.append(
                        f"grep: {p.original}: Is a directory")
                    continue
                data = split_lines((await
                                    rb(p.original)).decode(errors="replace"))
                hits = grep_lines(p.original, data, pat, invert, line_numbers,
                                  count_only, files_only, only_matching,
                                  max_count)
                if count_only:
                    if hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                elif files_only:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{p.original}:{r}" for r in hits)
            stderr = format_optional_records(multi_warnings)
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return format_records(all_results), IOResult(stderr=stderr)

        first_stat = await st(paths[0].original)
        if first_stat.type == FileType.DIRECTORY:
            stderr = f"grep: {paths[0].original}: Is a directory\n".encode()
            return b"", IOResult(exit_code=1, stderr=stderr)

        if read_stream is not None:
            source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        else:
            data = await rb(paths[0].original)
            source = _wrap_bytes(data)
        stream = grep_stream(
            source,
            pat,
            invert=invert,
            line_numbers=line_numbers,
            only_matching=only_matching,
            max_count=max_count,
            count_only=count_only,
            after_context=after_context,
            before_context=before_context,
        )
        if quiet:
            io = IOResult(exit_code=1)
            return quiet_match(stream, io), io
        io = IOResult()
        return exit_on_empty(stream, io), io

    source = _resolve_source(stdin, "grep: usage: grep [flags] pattern [path]")
    pat = compile_pattern(pattern, ignore_case, fixed_string, whole_word)
    stream = grep_stream(
        source,
        pat,
        invert=invert,
        line_numbers=line_numbers,
        only_matching=only_matching,
        max_count=max_count,
        count_only=count_only,
        after_context=after_context,
        before_context=before_context,
    )
    if quiet:
        io = IOResult(exit_code=1)
        return quiet_match(stream, io), io
    io = IOResult()
    return exit_on_empty(stream, io), io


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


__all__ = ["grep"]
