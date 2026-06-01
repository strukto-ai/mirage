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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_helper import (classify_pattern,
                                                 compile_pattern, grep_lines)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github.constants import SCOPE_ERROR, SCOPE_WARN
from mirage.core.github.glob import resolve_glob
from mirage.core.github.read import read as github_read
from mirage.core.github.scope import should_use_search
from mirage.core.github.search import search_code
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _rg_tree_search(
    index,
    search_path: str,
    pattern: str,
    ignore_case: bool,
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    only_matching: bool,
    max_count: int | None,
    fixed_string: bool,
    whole_word: bool,
    hidden: bool,
) -> list[str]:
    compile_pattern(pattern, ignore_case, fixed_string, whole_word)
    key = search_path
    prefix = key + "/" if key else ""
    blob_paths = sorted(p for p, e in index._entries.items()
                        if e.resource_type == "file" and (
                            not key or p.startswith(prefix) or p == key))
    return blob_paths


@command("rg", resource="github", spec=SPECS["rg"])
async def rg(
    accessor: GitHubAccessor,
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
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("rg: usage: rg [flags] pattern [path]")
    pattern_str = texts[0]
    max_count = int(m) if m is not None else None
    pat = compile_pattern(pattern_str, i, F, w)

    mount_prefix = paths[0].prefix if paths else ""
    if paths and index is not None:
        blob_set: set[str] = set()
        for path_item in paths:
            p_prefix = (path_item.prefix
                        if isinstance(path_item, PathSpec) else "")
            key = (path_item.original
                   if isinstance(path_item, PathSpec) else path_item)
            if p_prefix and key.startswith(p_prefix):
                key = key[len(p_prefix):] or "/"
            search_prefix = key + "/" if key else ""
            for p, e in index._entries.items():
                if e.resource_type == "file" and (
                        not key or p.startswith(search_prefix) or p == key):
                    blob_set.add(p)
        blob_paths = sorted(blob_set)

        first_p = paths[0]
        first_prefix = first_p.prefix if isinstance(first_p, PathSpec) else ""
        first_key = first_p.original if isinstance(first_p,
                                                   PathSpec) else first_p
        if first_prefix and first_key.startswith(first_prefix):
            first_key = first_key[len(first_prefix):] or "/"
        pt = classify_pattern(pattern_str, F)
        use_search = (should_use_search(
            is_regex=(pt == PatternType.REGEX),
            recursive=True,
            on_default_branch=(accessor.ref == accessor.default_branch),
        ) and len(blob_paths) > SCOPE_WARN)
        if use_search:
            try:
                results = await search_code(accessor.config,
                                            accessor.owner,
                                            accessor.repo,
                                            query=pattern_str,
                                            path_filter=first_key or None)
                if results:
                    api_paths = {r.path for r in results}
                    blob_paths = [p for p in blob_paths if p in api_paths]
            except Exception:
                pass
        if len(blob_paths) > SCOPE_ERROR:
            msg = (f"rg: {len(blob_paths)} files in scope,"
                   f" narrow the path\n")
            return b"", IOResult(exit_code=1, stderr=msg.encode())

        all_results: list[str] = []
        any_match = False
        for bp in blob_paths:
            if not hidden and any(
                    part.startswith(".") for part in bp.split("/")):
                continue
            try:
                data = await github_read(accessor, bp, index)
            except (FileNotFoundError, IsADirectoryError):
                continue
            text = data.decode(errors="replace")
            lines = text.splitlines()
            matched = grep_lines(bp,
                                 lines,
                                 pat,
                                 invert=v,
                                 line_numbers=n,
                                 count_only=c,
                                 files_only=args_l,
                                 only_matching=o,
                                 max_count=max_count)
            if not matched:
                continue
            any_match = True
            if args_l:
                display = mount_prefix + "/" + bp.lstrip(
                    "/") if mount_prefix else bp
                all_results.append(display)
                continue
            if c:
                display = mount_prefix + "/" + bp.lstrip(
                    "/") if mount_prefix else bp
                all_results.append(f"{display}:{len(matched)}")
                continue
            for line in matched:
                display = mount_prefix + "/" + bp.lstrip(
                    "/") if mount_prefix else bp
                all_results.append(f"{display}:{line}")
        if not any_match:
            return b"", IOResult(exit_code=1)
        return format_records(all_results), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("rg: usage: rg [flags] pattern path")
    paths = await resolve_glob(accessor, paths, index)
    lines = raw.decode(errors="replace").splitlines()
    matched = grep_lines("<stdin>",
                         lines,
                         pat,
                         invert=v,
                         line_numbers=n,
                         count_only=c,
                         files_only=args_l,
                         only_matching=o,
                         max_count=max_count)
    if not matched:
        return b"", IOResult(exit_code=1)
    if c:
        return str(len(matched)).encode() + b"\n", IOResult()
    result_lines: list[str] = []
    for line in matched:
        result_lines.append(line)
    return format_records(result_lines), IOResult()
