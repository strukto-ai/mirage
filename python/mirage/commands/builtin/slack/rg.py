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

import logging
from collections.abc import AsyncIterator

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import compile_pattern, grep_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.slack.formatters import (build_query,
                                          format_file_grep_results,
                                          format_grep_results)
from mirage.core.slack.glob import resolve_glob
from mirage.core.slack.read import read as slack_read
from mirage.core.slack.readdir import readdir as _readdir
from mirage.core.slack.scope import coalesce_scopes, detect_scope
from mirage.core.slack.search import (search_available, search_files,
                                      search_messages)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def _collect_files(
    accessor: SlackAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
) -> list[str]:
    try:
        children = await _readdir(accessor, path, index)
    except FileNotFoundError:
        return []
    files: list[str] = []
    for child in children:
        if child.endswith(".json") or child.endswith(".jsonl"):
            files.append(child)
        else:
            child_spec = PathSpec(original=child,
                                  directory=child,
                                  resolved=False,
                                  prefix=path.prefix)
            files.extend(await _collect_files(accessor, child_spec, index))
    return files


@command("rg", resource="slack", spec=SPECS["rg"])
async def rg(
    accessor: SlackAccessor,
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
    pattern_str = texts[0]
    max_count = int(m) if m is not None else None
    pat = compile_pattern(pattern_str, i, F, w)

    if paths:
        scope = detect_scope(paths[0])
        if not scope.use_native:
            scope = coalesce_scopes(paths) or scope

        if scope.use_native and search_available(accessor.config):
            file_prefix = paths[0].prefix or ""
            query = build_query(pattern_str, scope)
            target = getattr(scope, "target", None)
            do_msgs = target in (None, "date", "messages")
            do_files = target in (None, "date", "files")
            native_lines: list[str] = []
            err: Exception | None = None
            try:
                if do_msgs:
                    raw = await search_messages(accessor.config,
                                                query,
                                                count=max_count or 100)
                    native_lines.extend(
                        format_grep_results(raw, scope, file_prefix))
                if do_files:
                    raw_f = await search_files(accessor.config,
                                               query,
                                               count=max_count or 100)
                    native_lines.extend(
                        format_file_grep_results(raw_f, scope, file_prefix))
            except Exception as exc:
                err = exc
            if err is None:
                if not native_lines:
                    return b"", IOResult(exit_code=1)
                return ("\n".join(native_lines) + "\n").encode(), IOResult()
            logger.warning(
                "slack search push-down failed (%s); "
                "falling back to per-file scan", err)

        paths = await resolve_glob(accessor, paths, index)
        blob_paths: list[str] = []
        file_prefix = paths[0].prefix if paths else ""
        for path_item in paths:
            blob_paths.extend(await _collect_files(accessor, path_item, index))
        blob_paths = sorted(set(blob_paths))
        all_results: list[str] = []
        any_match = False
        for bp in blob_paths:
            if not hidden and any(
                    part.startswith(".") for part in bp.split("/")):
                continue
            try:
                bp_spec = PathSpec(original=bp,
                                   directory=bp,
                                   resolved=True,
                                   prefix=file_prefix)
                data = await slack_read(accessor, bp_spec, index)
            except (FileNotFoundError, IsADirectoryError, RuntimeError):
                continue
            text = data.decode(errors="replace")
            if not text:
                continue
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
                all_results.append(bp)
                continue
            if c:
                all_results.append(f"{bp}:{len(matched)}")
                continue
            for line in matched:
                all_results.append(f"{bp}:{line}")
        if not any_match:
            return b"", IOResult(exit_code=1)
        return "\n".join(all_results).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("rg: usage: rg [flags] pattern path")
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
        return str(len(matched)).encode(), IOResult()
    result_lines: list[str] = []
    for line in matched:
        result_lines.append(line)
    return "\n".join(result_lines).encode(), IOResult()
