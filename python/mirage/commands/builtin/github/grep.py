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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_helper import (classify_pattern,
                                                 compile_pattern,
                                                 grep_files_only, grep_lines,
                                                 grep_recursive, grep_stream)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github.glob import resolve_glob
from mirage.core.github.read import read as github_read
from mirage.core.github.readdir import readdir as _readdir
from mirage.core.github.scope import should_use_search
from mirage.core.github.search import narrow_paths
from mirage.core.github.stat import stat as _stat
from mirage.io.stream import exit_on_empty, quiet_match
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import FileType, PathSpec


async def _rb(accessor, index, prefix, path) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path, prefix=prefix)
    return await github_read(accessor, path, index)


async def _rd(accessor, index, prefix, path) -> list[str]:
    if index is None:
        raise FileNotFoundError(path)
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path, prefix=prefix)
    return await _readdir(accessor, path, index)


async def _st(accessor, index, prefix, path):
    if index is None:
        raise FileNotFoundError(path)
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path, prefix=prefix)
    return await _stat(accessor, path, index)


async def _estimate_recursive(index, path: str) -> tuple[int, int]:
    prefix = path.rstrip("/") + "/"
    total = 0
    ops = 0
    for entry_path, entry in index._entries.items():
        if entry.resource_type != "file":
            continue
        if not entry_path.startswith(prefix):
            continue
        total += entry.size or 0
        ops += 1
    return total, ops


async def grep_provision(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    *texts: str,
    r: bool = False,
    R: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    if not paths or index is None:
        return ProvisionResult(command="grep " + " ".join(texts))
    recursive = r or R
    total = 0
    ops = 0
    for p in paths:
        p_prefix = p.prefix if isinstance(p, PathSpec) else ""
        key = p.original if isinstance(p, PathSpec) else str(p)
        if p_prefix and key.startswith(p_prefix):
            key = key[len(p_prefix):] or "/"
        result = await index.get(key)
        if result.entry is None:
            continue
        if result.entry.resource_type == "folder":
            if recursive:
                t, o = await _estimate_recursive(index, key)
                total += t
                ops += o
        else:
            total += result.entry.size or 0
            ops += 1
    return ProvisionResult(
        command=f"grep {texts[0] if texts else ''} ...",
        network_read_low=total,
        network_read_high=total,
        read_ops=ops,
    )


@command("grep",
         resource="github",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: GitHubAccessor,
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

    if paths and index is not None:
        mount_prefix = paths[0].prefix if paths else ""
        rd = partial(_rd, accessor, index, mount_prefix)
        st = partial(_st, accessor, index, mount_prefix)
        rb = partial(_rb, accessor, index, mount_prefix)

        pt = classify_pattern(pattern, F)
        use_search = should_use_search(
            is_regex=(pt == PatternType.REGEX),
            recursive=(r or R),
            on_default_branch=(accessor.ref == accessor.default_branch),
        )
        if use_search:
            narrowed = await narrow_paths(accessor.config, accessor.owner,
                                          accessor.repo, pattern, paths)
            paths = (narrowed if narrowed else await resolve_glob(
                accessor, paths, index))
        else:
            paths = await resolve_glob(accessor, paths, index)

        multi = len(paths) > 1 or r or R

        if args_l:
            all_results: list[str] = []
            warnings_l: list[str] = []
            for p in paths:
                s = await st(p)
                if s.type == FileType.DIRECTORY:
                    if r or R:
                        res = await grep_files_only(
                            rd,
                            st,
                            rb,
                            p.original,
                            pattern,
                            recursive=True,
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
                        all_results.extend(res)
                    else:
                        warnings_l.append(
                            f"grep: {p.original}: Is a directory")
                    continue
                res = await grep_files_only(
                    rd,
                    st,
                    rb,
                    p.original,
                    pattern,
                    recursive=False,
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
                all_results.extend(res)
            stderr = "\n".join(warnings_l).encode() if warnings_l else None
            if not all_results:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return "\n".join(all_results).encode(), IOResult(stderr=stderr)

        pat = compile_pattern(pattern, i, F, w)
        all_results = []
        warnings_g: list[str] = []
        for p in paths:
            s = await st(p)
            if s.type == FileType.DIRECTORY:
                if r or R:
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
                        warnings=warnings_g,
                    )
                    all_results.extend(res)
                else:
                    warnings_g.append(f"grep: {p.original}: Is a directory")
                continue
            try:
                data = await rb(p.original)
            except FileNotFoundError:
                warnings_g.append(
                    f"grep: {p.original}: No such file or directory")
                continue
            text = data.decode(errors="replace")
            file_lines = grep_lines(p.original,
                                    text.splitlines(),
                                    pat,
                                    invert=v,
                                    line_numbers=n,
                                    count_only=c,
                                    files_only=False,
                                    only_matching=o,
                                    max_count=max_count)
            if multi:
                if c and file_lines:
                    all_results.append(f"{p.original}:{file_lines[0]}")
                else:
                    all_results.extend(f"{p.original}:{line}"
                                       for line in file_lines)
            else:
                all_results.extend(file_lines)
        stderr = "\n".join(warnings_g).encode() if warnings_g else None
        if not all_results:
            return b"", IOResult(exit_code=1, stderr=stderr)
        return "\n".join(all_results).encode(), IOResult(stderr=stderr)

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
