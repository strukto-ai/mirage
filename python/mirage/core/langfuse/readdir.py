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

from typing import Any

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.langfuse.client import (
    fetch_dataset_items,
    fetch_dataset_runs,
    fetch_datasets,
    fetch_prompts,
    fetch_sessions,
    fetch_traces,
)
from mirage.core.langfuse.scope import TOP_LEVEL_DIRS, detect_scope
from mirage.core.render.json import jsonl_bytes
from mirage.types import DirListing, FileStat, FileType


def _bounded(accessor: LangfuseAccessor, traces: list[dict[str, Any]]) -> bool:
    """Whether a trace listing may have left traces out.

    It is one page of at most ``default_trace_limit`` traces from
    ``default_from_timestamp`` on, so a full page or a set window is a
    truncated view, not the directory: cached as complete it would prove
    an older trace absent while read fetches it by id.
    """
    return len(traces) >= accessor.config.default_trace_limit or bool(
        accessor.config.default_from_timestamp
    )


def _session_extra(match: ScopeMatch) -> dict[str, str]:
    return {"session_id": match.slots["session_id"]}


def _prompt_extra(match: ScopeMatch) -> dict[str, str]:
    return {"prompt_name": match.slots["prompt_name"]}


def _dataset_extra(match: ScopeMatch) -> dict[str, str]:
    return {"dataset_name": match.slots["dataset_name"]}


# What each kind's stat carries in ``extra``, listed or not.
EXTRAS = {
    "session": _session_extra,
    "prompt": _prompt_extra,
    "dataset": _dataset_extra,
}


def _dirs(names: list[str]) -> list[FileStat]:
    return [FileStat(name=name, type=FileType.DIRECTORY) for name in names]


def _trace_rows(traces: list[dict[str, Any]]) -> list[FileStat]:
    return [
        FileStat(name=f"{t.get('id', '')}.json", type=FileType.FILE)
        for t in traces
    ]


async def _list_traces(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> DirListing:
    traces = await fetch_traces(
        accessor.api,
        limit=accessor.config.default_trace_limit,
        from_timestamp=accessor.config.default_from_timestamp,
    )
    # The list endpoint returns trace summaries while a read renders the
    # full trace with its observations, so a size here would cost one
    # fetch_trace per entry. Traces and prompts stay size-unknown until a
    # read hydrates them; the dataset .jsonl files below are sized
    # because their listing already carries every item.
    return DirListing(
        entries=_trace_rows(traces), partial=_bounded(accessor, traces)
    )


async def _list_sessions(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> DirListing:
    # One page of the newest sessions: an older one that drops off it has
    # not been deleted, so the listing evicts nothing.
    sessions = await fetch_sessions(accessor.api)
    return DirListing(
        entries=_dirs([s.get("id", "") for s in sessions]), window=True
    )


async def _list_session_traces(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> DirListing:
    traces = await fetch_traces(
        accessor.api,
        session_id=match.slots["session_id"],
        limit=accessor.config.default_trace_limit,
        from_timestamp=accessor.config.default_from_timestamp,
    )
    return DirListing(
        entries=_trace_rows(traces), partial=_bounded(accessor, traces)
    )


async def _list_prompts(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> DirListing:
    prompts = await fetch_prompts(accessor.api)
    names = list(dict.fromkeys(p.get("name", "") for p in prompts))
    return DirListing(entries=_dirs(names), window=True)


async def _list_prompt_versions(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> list[FileStat]:
    prompt_name = match.slots["prompt_name"]
    prompts = await fetch_prompts(accessor.api)
    rows: list[FileStat] = []
    for p in prompts:
        if p.get("name") != prompt_name:
            continue
        # The list endpoint returns PromptMeta, which carries every
        # version of a prompt in a `versions` array; there is no scalar
        # `version`.
        rows.extend(
            FileStat(name=f"{version}.json", type=FileType.FILE)
            for version in sorted(p.get("versions", []))
        )
    return rows


async def _list_datasets(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> DirListing:
    datasets = await fetch_datasets(accessor.api)
    return DirListing(
        entries=_dirs([d.get("name", "") for d in datasets]), window=True
    )


async def _list_dataset(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> list[FileStat]:
    # One dataset_items call per dataset directory actually entered: the
    # dataset listing carries no item payloads, so items.jsonl can only
    # be sized here, and only for datasets the caller opens.
    items = await fetch_dataset_items(
        accessor.api, match.slots["dataset_name"]
    )
    return [
        FileStat(
            name="items.jsonl",
            type=FileType.FILE,
            size=len(jsonl_bytes(items)),
        ),
        FileStat(name="runs", type=FileType.DIRECTORY),
    ]


async def _list_dataset_runs(
    accessor: LangfuseAccessor, match: ScopeMatch
) -> DirListing:
    runs = await fetch_dataset_runs(accessor.api, match.slots["dataset_name"])
    # The listing already carries the run document read() renders, so
    # each run file's exact size is free here.
    rows = [
        FileStat(
            name=f"{r.get('name', '')}.jsonl",
            type=FileType.FILE,
            size=len(jsonl_bytes([r])),
        )
        for r in runs
    ]
    return DirListing(entries=rows, window=True)


readdir = make_readdir(
    detect_scope,
    listers={
        "traces": _list_traces,
        "sessions": _list_sessions,
        "session": _list_session_traces,
        "prompts": _list_prompts,
        "prompt": _list_prompt_versions,
        "datasets": _list_datasets,
        "dataset": _list_dataset,
        "runs": _list_dataset_runs,
    },
    static_root=tuple(TOP_LEVEL_DIRS),
    extras=EXTRAS,
)
