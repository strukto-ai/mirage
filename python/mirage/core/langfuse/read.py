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
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.langfuse.client import (
    fetch_dataset_items,
    fetch_dataset_runs,
    fetch_or_enoent,
    fetch_prompt,
    fetch_trace,
)
from mirage.core.langfuse.scope import detect_scope
from mirage.core.render.json import json_bytes, jsonl_bytes
from mirage.errors.fs import enoent
from mirage.types import FileStat, PathSpec


def _in_session(trace: dict[str, Any], session_id: str) -> bool:
    roots = [trace]
    roots.extend(
        o for o in trace.get("observations", []) if o.get("isRootObservation")
    )
    return any(r.get("sessionId") == session_id for r in roots)


async def fetch_trace_file(
    accessor: LangfuseAccessor, match: ScopeMatch, path: PathSpec
) -> dict[str, Any]:
    """The trace a trace path names, or ENOENT.

    A trace is addressed by its id whatever the listing holds: the
    listing stops at ``default_trace_limit`` and
    ``default_from_timestamp``, and an older trace is still the
    project's. Under ``sessions/<id>/`` the trace must have a root
    observation in that session, the rule its listing uses, so a path
    cannot name another session's trace.

    Args:
        accessor (LangfuseAccessor): The mount's accessor.
        match (ScopeMatch): A ``trace`` or ``session_trace`` match.
        path (PathSpec): The trace file's path.
    """
    data = await fetch_or_enoent(
        fetch_trace(accessor.api, match.slots["trace_id"]), path.virtual
    )
    session_id = match.slots.get("session_id")
    if session_id is not None and not _in_session(data, session_id):
        raise enoent(path.virtual)
    return data


async def _read_trace(
    accessor: LangfuseAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    return json_bytes(await fetch_trace_file(accessor, match, path))


async def _read_prompt_version(
    accessor: LangfuseAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    # The scope's codec only matches plain ASCII integers, so the int()
    # here cannot raise.
    data = await fetch_or_enoent(
        fetch_prompt(
            accessor.api,
            match.slots["prompt_name"],
            int(match.slots["version"]),
        ),
        path.virtual,
    )
    return json_bytes(data)


async def _read_dataset_items(
    accessor: LangfuseAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    items = await fetch_or_enoent(
        fetch_dataset_items(accessor.api, match.slots["dataset_name"]),
        path.virtual,
    )
    return jsonl_bytes(items)


async def _read_dataset_run(
    accessor: LangfuseAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    run_name = match.slots["run_name"]
    runs = await fetch_or_enoent(
        fetch_dataset_runs(
            accessor.api, match.slots["dataset_name"], run_name
        ),
        path.virtual,
    )
    matched = [r for r in runs if r.get("name") == run_name]
    if not matched:
        raise enoent(path.virtual)
    # A .jsonl path must render as line-delimited JSON, not an indented
    # document: readers that split on newlines (jq) otherwise choke on
    # the first bare brace.
    return jsonl_bytes(matched[:1])


read = make_read(
    detect_scope,
    {
        "trace": _read_trace,
        "session_trace": _read_trace,
        "prompt_version": _read_prompt_version,
        "dataset_items": _read_dataset_items,
        "dataset_run": _read_dataset_run,
    },
)
