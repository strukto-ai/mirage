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

import json
import re
from collections.abc import AsyncIterator
from functools import partial

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_files_only, grep_lines,
                                                 grep_stream)
from mirage.commands.builtin.langfuse._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.langfuse._client import (fetch_datasets, fetch_prompts,
                                          fetch_sessions, fetch_traces)
from mirage.core.langfuse.glob import resolve_glob
from mirage.core.langfuse.read import read as langfuse_read
from mirage.core.langfuse.readdir import readdir as _readdir
from mirage.core.langfuse.scope import detect_scope
from mirage.core.langfuse.stat import stat as _stat
from mirage.io.stream import exit_on_empty, quiet_match, yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


def _filter_traces(
    traces: list[dict],
    pattern: re.Pattern,
) -> tuple[bytes, IOResult]:
    lines: list[str] = []
    for t in traces:
        trace_id = t.get("id", "")
        line_json = json.dumps(t, ensure_ascii=False)
        if not pattern.search(line_json):
            continue
        line = f"traces/{trace_id}.json:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return "\n".join(lines).encode(), IOResult()


def _format_session_results(
    sessions: list[dict],
    pattern: re.Pattern,
) -> tuple[bytes, IOResult]:
    lines: list[str] = []
    for s in sessions:
        session_id = s.get("id", "")
        if not pattern.search(session_id):
            continue
        line_json = json.dumps(s, ensure_ascii=False)
        line = f"sessions/{session_id}:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return "\n".join(lines).encode(), IOResult()


def _format_prompt_results(
    prompts: list[dict],
    pattern: re.Pattern,
) -> tuple[bytes, IOResult]:
    lines: list[str] = []
    seen: set[str] = set()
    for p in prompts:
        prompt_name = p.get("name", "")
        if prompt_name in seen:
            continue
        if not pattern.search(prompt_name):
            continue
        seen.add(prompt_name)
        line_json = json.dumps(p, ensure_ascii=False)
        line = f"prompts/{prompt_name}:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return "\n".join(lines).encode(), IOResult()


def _format_dataset_results(
    datasets: list[dict],
    pattern: re.Pattern,
) -> tuple[bytes, IOResult]:
    lines: list[str] = []
    for d in datasets:
        dataset_name = d.get("name", "")
        if not pattern.search(dataset_name):
            continue
        line_json = json.dumps(d, ensure_ascii=False)
        line = f"datasets/{dataset_name}:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return "\n".join(lines).encode(), IOResult()


async def grep_provision(
    accessor: LangfuseAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "grep " + " ".join(texts + tuple(str(p) for p in paths)))


@command("grep",
         resource="langfuse",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: LangfuseAccessor,
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

    config = accessor.config
    limit = config.default_search_limit

    if paths:
        scope = detect_scope(paths[0])

        if scope.level == "traces" or scope.level == "root":
            traces = await fetch_traces(
                accessor.api,
                limit=limit,
            )
            pat = compile_pattern(pattern, i, F, w)
            return _filter_traces(traces, pat)

        if scope.level == "sessions":
            sessions = await fetch_sessions(
                accessor.api,
                limit=limit,
            )
            pat = compile_pattern(pattern, i, F, w)
            return _format_session_results(sessions, pat)

        if scope.level == "prompts":
            prompts = await fetch_prompts(accessor.api)
            pat = compile_pattern(pattern, i, F, w)
            return _format_prompt_results(prompts, pat)

        if scope.level == "datasets":
            datasets = await fetch_datasets(accessor.api)
            pat = compile_pattern(pattern, i, F, w)
            return _format_dataset_results(datasets, pat)

        paths = await resolve_glob(accessor, paths, index=index)
        file_prefix = paths[0].prefix if paths else ""
        rd = partial(call_readdir,
                     _readdir,
                     accessor,
                     index=index,
                     prefix=file_prefix)
        st = partial(call_stat,
                     _stat,
                     accessor,
                     index=index,
                     prefix=file_prefix)
        rb = partial(call_read_bytes,
                     langfuse_read,
                     accessor,
                     index=index,
                     prefix=file_prefix)

        if args_l:
            warnings: list[str] = []
            results_l = await grep_files_only(
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
                warnings=warnings,
            )
            stderr = ("\n".join(warnings).encode() if warnings else None)
            if not results_l:
                return b"", IOResult(exit_code=1, stderr=stderr)
            return ("\n".join(results_l).encode(), IOResult(stderr=stderr))

        pat = compile_pattern(pattern, i, F, w)

        if len(paths) > 1:
            all_results: list[str] = []
            for p in paths:
                data = (await
                        rb(p.original)).decode(errors="replace").splitlines()
                hits = grep_lines(p.original, data, pat, v, n, c, args_l, o,
                                  max_count)
                if c:
                    if hits:
                        all_results.append(f"{p.original}:{hits[0]}")
                elif args_l:
                    all_results.extend(hits)
                else:
                    all_results.extend(f"{p.original}:{r_}" for r_ in hits)
            if not all_results:
                return b"", IOResult(exit_code=1)
            return "\n".join(all_results).encode(), IOResult()

        data = await rb(paths[0].original)
        source = yield_bytes(data)
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
