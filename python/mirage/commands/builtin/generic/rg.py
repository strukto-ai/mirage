from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)
from dataclasses import dataclass
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.cache.read_through import (cache_aware_read_bytes,
                                       cache_aware_read_stream)
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_count_has_matches,
                                                 grep_lines, grep_stream,
                                                 nonzero_count_stream,
                                                 resolve_pattern)
from mirage.commands.builtin.rg_helper import rg_full
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.output import (format_optional_records,
                                                  format_records)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.stream import exit_on_empty
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import rebase_display


@dataclass(frozen=True, slots=True)
class RgFlags:
    """Parsed rg flags (TS RgFlags parity); the complete set rg honors."""
    ignore_case: bool
    invert: bool
    line_numbers: bool
    count_only: bool
    files_only: bool
    whole_word: bool
    fixed_string: bool
    only_matching: bool
    hidden: bool
    file_type: str | None
    glob_pattern: str | None
    max_count: int | None
    context_after: int
    context_before: int


def parse_flags(fl: FlagView, never_match: bool) -> RgFlags:
    """Convert the raw flag bag into RgFlags, the only string-keyed reads.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        never_match (bool): zero-pattern sentinel from resolve_pattern; it is
            a regex, so it suppresses -F.
    """
    a_ctx = fl.int("A")
    b_ctx = fl.int("B")
    c_ctx = fl.int("C")
    context_after = a_ctx if a_ctx is not None else 0
    context_before = b_ctx if b_ctx is not None else 0
    if c_ctx is not None:
        # rg family: -C overrides -A/-B (grep keeps -A/-B precedence)
        context_before = context_after = c_ctx
    return RgFlags(
        ignore_case=fl.bool("i"),
        invert=fl.bool("v"),
        line_numbers=fl.bool("n"),
        count_only=fl.bool("c"),
        files_only=fl.bool("args_l"),
        whole_word=fl.bool("w"),
        fixed_string=fl.bool("F") and not never_match,
        only_matching=fl.bool("o"),
        hidden=fl.bool("hidden"),
        file_type=fl.str("type"),
        glob_pattern=fl.str("glob"),
        max_count=fl.int("m"),
        context_after=context_after,
        context_before=context_before,
    )


async def rg(
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
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Run ripgrep-style fallback search over backend paths or stdin.

    Interprets the raw flag kwargs itself (TS rgGeneric parity), so backend
    wrappers only wire paths, texts, flags, and backend I/O.

    Args:
        paths (list[PathSpec]): Backend paths to search. Empty paths consume
            stdin.
        texts (Sequence[str]): positional TEXT operands (the pattern unless
            -e/-f supplied it).
        flags (Mapping[str, object] | None): raw flag kwargs from the
            dispatcher (e, f, i, v, n, c, args_l, w, F, o, m, A, B, C,
            hidden, type, glob).
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
        index (IndexCacheStore | None): Optional cache index for wrapped
            backend calls.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    read_bytes = cache_aware_read_bytes(read_bytes)
    if read_stream is not None:
        read_stream = cache_aware_read_stream(read_stream)
    fl = FlagView(flags, spec=SPECS["rg"])
    pattern, never_match = await resolve_pattern(
        texts, fl, read_bytes, accessor, index,
        "rg: usage: rg [flags] pattern [path]")
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
            scope_warning_str = await scope_check(rd, st, paths[0], True)

        is_dir = False
        try:
            s = await st(paths[0].original)
            is_dir = s.type == FileType.DIRECTORY
        except (FileNotFoundError, ValueError):
            try:
                await rd(paths[0].original)
                is_dir = True
            except (FileNotFoundError, ValueError):
                pass

        needs_full = (is_dir or f.files_only or f.context_before
                      or f.context_after or f.file_type or f.glob_pattern)
        if needs_full:
            warnings_f: list[str] = []
            if scope_warning_str:
                warnings_f.append(scope_warning_str)
            results: list[str] = []
            for p in paths:
                hits_full = await rg_full(
                    rd,
                    st,
                    rb,
                    p.original,
                    pattern,
                    ignore_case=f.ignore_case,
                    invert=f.invert,
                    line_numbers=f.line_numbers,
                    count_only=f.count_only,
                    files_only=f.files_only,
                    fixed_string=f.fixed_string,
                    only_matching=f.only_matching,
                    max_count=f.max_count,
                    whole_word=f.whole_word,
                    context_before=f.context_before,
                    context_after=f.context_after,
                    file_type=f.file_type,
                    glob_pattern=f.glob_pattern,
                    hidden=f.hidden,
                    warnings=warnings_f,
                    file_prefix=p.display if len(paths) > 1 else None,
                )
                results.extend(rebase_display(hits_full, p.original,
                                              p.display))
            stderr = format_optional_records(warnings_f)
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return format_records(results), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, f.ignore_case, f.fixed_string,
                              f.whole_word)

        if len(paths) > 1:
            all_results: list[str] = []
            for p in paths:
                data = split_lines((await
                                    rb(p.original)).decode(errors="replace"))
                hits = grep_lines(p.display, data, pat, f.invert,
                                  f.line_numbers, f.count_only, f.files_only,
                                  f.only_matching, f.max_count)
                if f.count_only:
                    if grep_count_has_matches(hits):
                        all_results.append(f"{p.display}:{hits[0]}")
                elif f.files_only:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{p.display}:{r}" for r in hits)
            if not all_results:
                return b"", IOResult(exit_code=1)
            return format_records(all_results), IOResult()

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
        )
        if f.count_only:
            stream = nonzero_count_stream(stream)
        io = IOResult()
        return exit_on_empty(stream, io), io

    source = _resolve_source(stdin,
                             "rg: usage: rg [flags] pattern [path]",
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
    )
    if f.count_only:
        stream = nonzero_count_stream(stream)
    io = IOResult()
    return exit_on_empty(stream, io), io


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


__all__ = ["rg"]
