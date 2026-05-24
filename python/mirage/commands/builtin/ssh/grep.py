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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only, grep_lines,
                                                 grep_recursive, grep_stream)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ssh.glob import resolve_glob
from mirage.core.ssh.read import read_bytes as _read_bytes
from mirage.core.ssh.readdir import readdir as _readdir
from mirage.core.ssh.stat import stat as _stat
from mirage.core.ssh.stream import read_stream
from mirage.io.stream import exit_on_empty, quiet_match
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import FileType, PathSpec


async def grep_provision(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    *texts: str,
    r: bool = False,
    R: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor is None:
        return ProvisionResult(command="grep " + " ".join(texts))
    if not (r or R):
        paths = await resolve_glob(accessor, paths, index)
    if r or R:
        mount_prefix = paths[0].prefix if paths else ""
        entries = await _readdir(accessor, paths[0], index)
        total = 0
        ops = 0
        for entry in entries:
            try:
                e_spec = PathSpec(original=entry,
                                  directory=entry,
                                  resolved=False,
                                  prefix=mount_prefix)
                s = await _stat(accessor, e_spec)
                if s.size is not None:
                    total += s.size
                    ops += 1
            except FileNotFoundError:
                continue
        return ProvisionResult(
            command=f"grep -r {texts[0] if texts else ''} {paths[0].original}",
            network_read_low=total,
            network_read_high=total,
            read_ops=ops,
        )
    s = await _stat(accessor, paths[0])
    return ProvisionResult(
        command=f"grep {texts[0] if texts else ''} {paths[0].original}",
        network_read_low=s.size or 0,
        network_read_high=s.size or 0,
        read_ops=1,
    )


@command("grep", resource="ssh", spec=SPECS["grep"], provision=grep_provision)
async def grep(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    R: bool = False,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    E: bool = False,
    o: bool = False,
    m: str | None = None,
    q: bool = False,
    H: bool = False,
    args_h: bool = False,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    e: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if e is not None:
        pattern = e
    elif texts:
        pattern = texts[0]
    else:
        raise ValueError("grep: usage: grep [flags] pattern [path]")
    max_count = int(m) if m is not None else None
    after_ctx = int(A) if A is not None else (int(C) if C is not None else 0)
    before_ctx = int(B) if B is not None else (int(C) if C is not None else 0)

    if paths:
        paths = await resolve_glob(accessor, paths, index)
        mount_prefix = paths[0].prefix if paths else ""
        rd = partial(call_readdir,
                     _readdir,
                     accessor,
                     index=index,
                     prefix=mount_prefix)
        st = partial(call_stat, _stat, accessor, prefix=mount_prefix)
        rb = partial(call_read_bytes,
                     _read_bytes,
                     accessor,
                     prefix=mount_prefix)

        if args_l:
            warnings_l: list[str] = []
            results = await grep_files_only(
                rd,
                st,
                rb,
                paths[0].original,
                pattern,
                recursive=r or R,
                ignore_case=i,
                invert=v,
                line_numbers=n,
                count_only=c,
                fixed_string=F,
                only_matching=o,
                max_count=max_count,
                whole_word=w,
                warnings=warnings_l,
            )
            stderr = "\n".join(warnings_l).encode() if warnings_l else None
            if not results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(results).encode(), IOResult(stderr=stderr)

        if r or R:
            pat = compile_pattern(pattern, i, F, w)
            all_results: list[str] = []
            warnings_r: list[str] = []
            for p in paths:
                s = await _stat(accessor, p)
                if s.type == FileType.DIRECTORY:
                    res = await grep_recursive(
                        rd,
                        st,
                        rb,
                        p.original,
                        pat,
                        invert=v,
                        line_numbers=n,
                        count_only=c,
                        files_only=False,
                        only_matching=o,
                        max_count=max_count,
                        warnings=warnings_r,
                        read_stream_fn=None,
                    )
                    all_results.extend(res)
                else:
                    data = (await _read_bytes(
                        accessor, p)).decode(errors="replace").splitlines()
                    hits = grep_lines(p, data, pat, v, n, c, args_l, o,
                                      max_count)
                    if c and hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                    else:
                        all_results.extend(
                            f"{p.original}:{rl}" if len(paths) > 1 else rl
                            for rl in hits)
            stderr = ("\n".join(warnings_r).encode() if warnings_r else None)
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(all_results).encode(), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, i, F, w)

        if len(paths) > 1:
            all_results: list[str] = []
            for p in paths:
                data = (await
                        _read_bytes(accessor,
                                    p)).decode(errors="replace").splitlines()
                hits = grep_lines(p, data, pat, v, n, c, args_l, o, max_count)
                if c:
                    if hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                elif args_l:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{p.original}:{r}" for r in hits)
            if not all_results:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_results).encode(), IOResult()

        source = read_stream(accessor, paths[0])
        stream = grep_stream(
            source,
            pat,
            invert=v,
            line_numbers=n,
            only_matching=o,
            max_count=max_count,
            count_only=c,
            after_context=after_ctx,
            before_context=before_ctx,
        )
        if q:
            io = IOResult(exit_code=1)
            return quiet_match(stream, io), io
        io = IOResult()
        return exit_on_empty(stream, io), io

    source = _resolve_source(stdin, "grep: usage: grep [flags] pattern [path]")
    pat = compile_pattern(pattern, i, F, w)
    stream = grep_stream(
        source,
        pat,
        invert=v,
        line_numbers=n,
        only_matching=o,
        max_count=max_count,
        count_only=c,
        after_context=after_ctx,
        before_context=before_ctx,
    )
    if q:
        io = IOResult(exit_code=1)
        return quiet_match(stream, io), io
    io = IOResult()
    return exit_on_empty(stream, io), io
