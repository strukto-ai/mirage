from collections.abc import AsyncIterator, Awaitable, Callable
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only,
                                                 grep_folder_filetype,
                                                 grep_lines, grep_recursive,
                                                 grep_stream)
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
    filetype_fns: dict | None = None,
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
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
    filetype_fns = filetype_fns or {}

    if paths:
        mount_prefix = paths[0].prefix
        rd = partial(call_readdir,
                     readdir,
                     accessor,
                     index=index,
                     prefix=mount_prefix)
        st = partial(call_stat, stat, accessor, prefix=mount_prefix)
        rb = partial(call_read_bytes,
                     read_bytes,
                     accessor,
                     prefix=mount_prefix)

        if recursive and filetype_fns:
            bound_ft = {
                ext: partial(fn, accessor)
                for ext, fn in filetype_fns.items()
            }
            warnings: list[str] = []
            results = await grep_folder_filetype(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                bound_ft,
                ignore_case=ignore_case,
                invert=invert,
                line_numbers=line_numbers,
                count_only=count_only,
                files_only=files_only,
                only_matching=only_matching,
                max_count=max_count,
                fixed_string=fixed_string,
                whole_word=whole_word,
                warnings=warnings,
                prefix=mount_prefix,
            )
            stderr = "\n".join(warnings).encode() if warnings else None
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        if files_only:
            warnings = []
            results = await grep_files_only(
                rd,
                st,
                rb,
                paths[0].original,
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
                read_stream_fn=partial(read_stream, accessor)
                if read_stream else None,
            )
            stderr = "\n".join(warnings).encode() if warnings else None
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        if recursive:
            pat = compile_pattern(pattern, ignore_case, fixed_string,
                                  whole_word)
            all_results: list[str] = []
            warnings = []
            for p in paths:
                s = await stat(accessor, p)
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
                        read_stream_fn=partial(read_stream, accessor)
                        if read_stream else None,
                    )
                    all_results.extend(res)
                else:
                    data = (await read_bytes(
                        accessor, p)).decode(errors="replace").splitlines()
                    hits = grep_lines(p.original, data, pat, invert,
                                      line_numbers, count_only, files_only,
                                      only_matching, max_count)
                    if count_only and hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                    else:
                        all_results.extend(
                            f"{p.original}:{rl}" if len(paths) > 1 else rl
                            for rl in hits)
            stderr = "\n".join(warnings).encode() if warnings else None
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(all_results).encode(), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

        if len(paths) > 1:
            all_results = []
            for p in paths:
                data = (await
                        read_bytes(accessor,
                                   p)).decode(errors="replace").splitlines()
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
            if not all_results:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_results).encode(), IOResult()

        if read_stream is not None:
            source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
        else:
            data = await read_bytes(accessor, paths[0])
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
