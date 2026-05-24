# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import AsyncIterator
from functools import partial

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern, grep_lines,
                                                 grep_stream)
from mirage.commands.builtin.rg_helper import rg_folder_filetype, rg_full
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.read import read_bytes as _read_bytes
from mirage.core.databricks_volume.readdir import readdir as _readdir
from mirage.core.databricks_volume.stat import stat as _stat
from mirage.core.databricks_volume.stream import read_stream
from mirage.io.stream import exit_on_empty
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


@command("rg", resource="databricks_volume", spec=SPECS["rg"])
async def rg(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    m: str | None = None,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    hidden: bool = False,
    type: str | None = None,
    glob: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("rg: usage: rg [flags] pattern [path]")
    pattern = texts[0]
    max_count = int(m) if m is not None else None
    context_after = int(A) if A is not None else 0
    context_before = int(B) if B is not None else 0
    if C is not None:
        context_before = context_after = int(C)

    filetype_fns = _extra.get("filetype_fns") or {}

    if paths:
        paths = await resolve_glob(accessor, paths, index)
        mount_prefix = paths[0].prefix if paths else ""
        rd = partial(call_readdir,
                     _readdir,
                     accessor,
                     index=index,
                     prefix=mount_prefix)
        st = partial(call_stat,
                     _stat,
                     accessor,
                     index=index,
                     prefix=mount_prefix)
        rb = partial(call_read_bytes,
                     _read_bytes,
                     accessor,
                     index=index,
                     prefix=mount_prefix)

        is_dir = False
        try:
            file_stat = await _stat(accessor, paths[0], index)
            is_dir = file_stat.type == FileType.DIRECTORY
        except (FileNotFoundError, ValueError):
            try:
                await _readdir(accessor, paths[0], index)
                is_dir = True
            except (FileNotFoundError, ValueError):
                pass

        if is_dir and filetype_fns:
            bound_ft = {
                ext: partial(fn, accessor)
                for ext, fn in filetype_fns.items()
            }
            warnings: list[str] = []
            results = await rg_folder_filetype(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                bound_ft,
                ignore_case=i,
                invert=v,
                line_numbers=n,
                count_only=c,
                files_only=args_l,
                only_matching=o,
                max_count=max_count,
                fixed_string=F,
                whole_word=w,
                file_type=type,
                glob_pattern=glob,
                hidden=hidden,
                warnings=warnings,
            )
            stderr = "\n".join(warnings).encode() if warnings else None
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if mount_prefix and args_l:
                results = [mount_prefix + "/" + r.lstrip("/") for r in results]
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        needs_full = (is_dir or args_l or context_before or context_after
                      or type or glob)
        if needs_full:
            warnings_f: list[str] = []
            results = await rg_full(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                ignore_case=i,
                invert=v,
                line_numbers=n,
                count_only=c,
                files_only=args_l,
                fixed_string=F,
                only_matching=o,
                max_count=max_count,
                whole_word=w,
                context_before=context_before,
                context_after=context_after,
                file_type=type,
                glob_pattern=glob,
                hidden=hidden,
                warnings=warnings_f,
            )
            stderr = "\n".join(warnings_f).encode() if warnings_f else None
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            if mount_prefix and args_l:
                results = [mount_prefix + "/" + r.lstrip("/") for r in results]
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        compiled = compile_pattern(pattern, i, F, w)

        if len(paths) > 1:
            all_results: list[str] = []
            for path in paths:
                data = (await _read_bytes(
                    accessor, path,
                    index)).decode(errors="replace").splitlines()
                hits = grep_lines(path.original, data, compiled, v, n, c,
                                  args_l, o, max_count)
                if c:
                    if hits:
                        all_results.append(f"{path.original}:{hits[0]}")
                elif args_l:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{path.original}:{line}"
                                       for line in hits)
            if not all_results:
                return b"", IOResult(exit_code=1)
            if mount_prefix:
                all_results = [
                    mount_prefix + "/" + result.lstrip("/")
                    for result in all_results
                ]
            return "\n".join(all_results).encode(), IOResult()

        source = read_stream(accessor, paths[0], index)
        stream = grep_stream(
            source,
            compiled,
            invert=v,
            line_numbers=n,
            only_matching=o,
            max_count=max_count,
            count_only=c,
        )
        io = IOResult()
        return exit_on_empty(stream, io), io
    source = _resolve_source(stdin, "rg: usage: rg [flags] pattern path")
    compiled = compile_pattern(pattern, i, F, w)
    stream = grep_stream(
        source,
        compiled,
        invert=v,
        line_numbers=n,
        only_matching=o,
        max_count=max_count,
        count_only=c,
    )
    io = IOResult()
    return exit_on_empty(stream, io), io
