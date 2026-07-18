from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)
from dataclasses import dataclass
from functools import partial

from mirage.cache.read_through import (cache_aware_bound_bytes,
                                       cache_aware_bound_stream)
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
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import rebase_raw


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
    with_filename: bool
    no_filename: bool
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
    a_ctx = fl.as_int("A")
    b_ctx = fl.as_int("B")
    c_ctx = fl.as_int("C")
    context_after = a_ctx if a_ctx is not None else 0
    context_before = b_ctx if b_ctx is not None else 0
    if c_ctx is not None:
        # rg family: -C overrides -A/-B (grep keeps -A/-B precedence)
        context_before = context_after = c_ctx
    return RgFlags(
        ignore_case=fl.as_bool("i"),
        invert=fl.as_bool("v"),
        line_numbers=fl.as_bool("n"),
        count_only=fl.as_bool("c"),
        files_only=fl.as_bool("args_l"),
        whole_word=fl.as_bool("w"),
        fixed_string=fl.as_bool("F") and not never_match,
        only_matching=fl.as_bool("o"),
        with_filename=fl.as_bool("H"),
        no_filename=fl.as_bool("args_I"),
        hidden=fl.as_bool("hidden"),
        file_type=fl.as_str("type"),
        glob_pattern=fl.as_str("glob"),
        max_count=fl.as_int("m"),
        context_after=context_after,
        context_before=context_before,
    )


async def rg(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, object] | None = None,
    *,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[..., Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    stdin: ByteSource | None = None,
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
            dispatcher (e, f, i, v, n, c, args_l, w, F, o, H, I, m, A, B, C,
            hidden, type, glob).
        readdir (Callable[..., Awaitable[list[str]]]): Directory reader.
        stat (Callable[[PathSpec], Awaitable[FileStat]]): Backend stat reader.
        read_bytes (Callable[..., Awaitable[bytes]]): Whole-file reader.
        read_stream (Callable[..., AsyncIterator[bytes]] | None): Optional
            stream reader.

    Returns:
        tuple[ByteSource | None, IOResult]: Output stream and exit metadata.
    """
    read_bytes = cache_aware_bound_bytes(read_bytes)
    if read_stream is not None:
        read_stream = cache_aware_bound_stream(read_stream)
    fl = FlagView(flags, spec=SPECS["rg"])
    pattern, never_match = await resolve_pattern(
        texts, fl, read_bytes, "rg: usage: rg [flags] pattern [path]")
    f = parse_flags(fl, never_match)

    if paths:
        mount_prefix = mount_prefix_of(paths[0].virtual,
                                       paths[0].resource_path)
        rd = partial(call_readdir, readdir, prefix=mount_prefix)
        st = partial(call_stat, stat, prefix=mount_prefix)
        rb = partial(call_read_bytes, read_bytes, prefix=mount_prefix)

        is_dir = False
        try:
            s = await st(paths[0].virtual)
            is_dir = s.type == FileType.DIRECTORY
        except (FileNotFoundError, ValueError):
            try:
                await rd(paths[0].virtual)
                is_dir = True
            except (FileNotFoundError, ValueError):
                # Neither statable nor listable: keep is_dir False and let
                # the plain-file search path report the real read error.
                pass

        # ripgrep labels when searching multiple files; -H forces the label
        # for a single file and -I suppresses it (cross-mount fanout forces
        # -H so per-operand native runs stay filename-keyed).
        label = (len(paths) > 1 or f.with_filename) and not f.no_filename
        needs_full = (is_dir or f.files_only or f.context_before
                      or f.context_after or f.file_type or f.glob_pattern)
        if needs_full:
            warnings_f: list[str] = []
            results: list[str] = []
            for p in paths:
                hits_full = await rg_full(
                    rd,
                    st,
                    rb,
                    p.virtual,
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
                    file_prefix=p.raw_path if label else None,
                    no_filename=f.no_filename,
                )
                results.extend(rebase_raw(hits_full, p.virtual, p.raw_path))
            stderr = format_optional_records(warnings_f)
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return format_records(results), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, f.ignore_case, f.fixed_string,
                              f.whole_word)

        if len(paths) > 1 or f.with_filename:
            all_results: list[str] = []
            for p in paths:
                data = split_lines((await
                                    rb(p.virtual)).decode(errors="replace"))
                hits = grep_lines(p.raw_path, data, pat, f.invert,
                                  f.line_numbers, f.count_only, f.files_only,
                                  f.only_matching, f.max_count)
                if f.count_only:
                    if grep_count_has_matches(hits):
                        all_results.append(
                            f"{p.raw_path}:{hits[0]}" if label else hits[0])
                elif f.files_only:
                    all_results.extend(hits)
                elif label:
                    all_results.extend(f"{p.raw_path}:{r}" for r in hits)
                else:
                    all_results.extend(hits)
            if not all_results:
                return b"", IOResult(exit_code=1)
            return format_records(all_results), IOResult()

        if read_stream is not None:
            source: AsyncIterator[bytes] = read_stream(paths[0])
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
