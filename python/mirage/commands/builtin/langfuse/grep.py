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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.grep_helper import compile_pattern, pattern_arg
from mirage.commands.builtin.langfuse._provision import file_read_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.langfuse._client import (fetch_datasets, fetch_prompts,
                                          fetch_sessions, fetch_traces)
from mirage.core.langfuse.glob import resolve_glob
from mirage.core.langfuse.read import read as langfuse_read
from mirage.core.langfuse.readdir import readdir as _readdir
from mirage.core.langfuse.scope import detect_scope
from mirage.core.langfuse.stat import stat as _stat
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
        line_json = json.dumps(t, ensure_ascii=False, separators=(",", ":"))
        if not pattern.search(line_json):
            continue
        line = f"traces/{trace_id}.json:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return format_records(lines), IOResult()


def _format_session_results(
    sessions: list[dict],
    pattern: re.Pattern,
) -> tuple[bytes, IOResult]:
    lines: list[str] = []
    for s in sessions:
        session_id = s.get("id", "")
        if not pattern.search(session_id):
            continue
        line_json = json.dumps(s, ensure_ascii=False, separators=(",", ":"))
        line = f"sessions/{session_id}:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return format_records(lines), IOResult()


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
        line_json = json.dumps(p, ensure_ascii=False, separators=(",", ":"))
        line = f"prompts/{prompt_name}:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return format_records(lines), IOResult()


def _format_dataset_results(
    datasets: list[dict],
    pattern: re.Pattern,
) -> tuple[bytes, IOResult]:
    lines: list[str] = []
    for d in datasets:
        dataset_name = d.get("name", "")
        if not pattern.search(dataset_name):
            continue
        line_json = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        line = f"datasets/{dataset_name}:{line_json}"
        lines.append(line)
    if not lines:
        return b"", IOResult(exit_code=1)
    return format_records(lines), IOResult()


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
    prefix: str = "",
    index: IndexCacheStore | None = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    limit = accessor.config.default_search_limit

    if paths and pattern is not None and "\n" not in pattern:
        scope = detect_scope(paths[0])
        ignore_case = fl.bool("i")
        fixed_string = fl.bool("F")
        whole_word = fl.bool("w")

        if scope.level == "traces" or scope.level == "root":
            traces = await fetch_traces(
                accessor.api,
                limit=limit,
            )
            pat = compile_pattern(pattern, ignore_case, fixed_string,
                                  whole_word)
            return _filter_traces(traces, pat)

        if scope.level == "sessions":
            sessions = await fetch_sessions(
                accessor.api,
                limit=limit,
            )
            pat = compile_pattern(pattern, ignore_case, fixed_string,
                                  whole_word)
            return _format_session_results(sessions, pat)

        if scope.level == "prompts":
            prompts = await fetch_prompts(accessor.api)
            pat = compile_pattern(pattern, ignore_case, fixed_string,
                                  whole_word)
            return _format_prompt_results(prompts, pat)

        if scope.level == "datasets":
            datasets = await fetch_datasets(accessor.api)
            pat = compile_pattern(pattern, ignore_case, fixed_string,
                                  whole_word)
            return _format_dataset_results(datasets, pat)

    resolved = await resolve_glob(accessor, paths,
                                  index=index) if paths else []
    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=langfuse_read,
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )
