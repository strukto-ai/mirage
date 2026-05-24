from collections.abc import AsyncIterator, Awaitable, Callable
from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern, grep_lines,
                                                 grep_stream)
from mirage.commands.builtin.rg_helper import rg_full
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.io.stream import exit_on_empty
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec


async def rg(
    paths: list[PathSpec],
    *,
    pattern: str,
    readdir: Callable[..., Awaitable[list[str]]],
    stat: Callable[[PathSpec], Awaitable[FileStat]],
    read_bytes: Callable[..., Awaitable[bytes]],
    read_stream: Callable[..., AsyncIterator[bytes]] | None,
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    ignore_case: bool = False,
    invert: bool = False,
    line_numbers: bool = False,
    count_only: bool = False,
    files_only: bool = False,
    whole_word: bool = False,
    fixed_string: bool = False,
    only_matching: bool = False,
    max_count: int | None = None,
    context_before: int = 0,
    context_after: int = 0,
    hidden: bool = False,
    file_type: str | None = None,
    glob_pattern: str | None = None,
    index: IndexCacheStore | None = None,
) -> tuple[ByteSource | None, IOResult]:
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

        is_dir = False
        try:
            s = await stat(accessor, paths[0])
            is_dir = s.type == FileType.DIRECTORY
        except (FileNotFoundError, ValueError):
            try:
                await readdir(accessor, paths[0], index)
                is_dir = True
            except (FileNotFoundError, ValueError):
                pass

        needs_full = (is_dir or files_only or context_before or context_after
                      or file_type or glob_pattern)
        if needs_full:
            warnings_f: list[str] = []
            results = await rg_full(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                ignore_case=ignore_case,
                invert=invert,
                line_numbers=line_numbers,
                count_only=count_only,
                files_only=files_only,
                fixed_string=fixed_string,
                only_matching=only_matching,
                max_count=max_count,
                whole_word=whole_word,
                context_before=context_before,
                context_after=context_after,
                file_type=file_type,
                glob_pattern=glob_pattern,
                hidden=hidden,
                warnings=warnings_f,
            )
            stderr = "\n".join(warnings_f).encode() if warnings_f else None
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if mount_prefix and files_only:
                results = [mount_prefix + "/" + r.lstrip("/") for r in results]
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

        if len(paths) > 1:
            all_results: list[str] = []
            for p in paths:
                data = split_lines(
                    (await read_bytes(accessor, p)).decode(errors="replace"))
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
            if mount_prefix:
                all_results = [
                    mount_prefix + "/" + r.lstrip("/") for r in all_results
                ]
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
        )
        io = IOResult()
        return exit_on_empty(stream, io), io

    source = _resolve_source(stdin, "rg: usage: rg [flags] pattern path")
    pat = compile_pattern(pattern, ignore_case, fixed_string, whole_word)
    stream = grep_stream(
        source,
        pat,
        invert=invert,
        line_numbers=line_numbers,
        only_matching=only_matching,
        max_count=max_count,
        count_only=count_only,
    )
    io = IOResult()
    return exit_on_empty(stream, io), io


async def _wrap_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


__all__ = ["rg"]
