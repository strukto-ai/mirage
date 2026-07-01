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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.langfuse._client import (fetch_dataset_runs, fetch_datasets,
                                          fetch_prompts, fetch_sessions,
                                          fetch_traces)
from mirage.types import PathSpec
from mirage.utils.errors import enoent

TOP_LEVEL_DIRS = ["traces", "sessions", "prompts", "datasets"]


async def readdir(
    accessor: LangfuseAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    """List directory contents.

    Args:
        accessor (LangfuseAccessor): langfuse accessor.
        path (PathSpec | str): resource-relative path.
        index (IndexCacheStore | None): index cache.
        prefix (str): mount prefix for virtual index keys.
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original
    prefix = path.prefix
    path = (path.dir if path.pattern else path).strip_prefix
    key = path.strip("/")

    if key and any(p.startswith(".") for p in key.split("/")):
        raise enoent(virtual)

    virtual_key = prefix + "/" + key if key else prefix or "/"

    if not key:
        return [f"{prefix}/{d}" for d in TOP_LEVEL_DIRS]

    parts = key.split("/")

    if parts[0] == "traces" and len(parts) == 1:
        return await _readdir_traces(accessor, virtual_key, index, prefix)

    if parts[0] == "sessions" and len(parts) == 1:
        return await _readdir_sessions(accessor, virtual_key, index, prefix)

    if parts[0] == "sessions" and len(parts) == 2:
        return await _readdir_session_traces(
            accessor,
            parts[1],
            virtual_key,
            index,
            prefix,
        )

    if parts[0] == "prompts" and len(parts) == 1:
        return await _readdir_prompts(accessor, virtual_key, index, prefix)

    if parts[0] == "prompts" and len(parts) == 2:
        return await _readdir_prompt_versions(
            accessor,
            parts[1],
            virtual_key,
            index,
            prefix,
        )

    if parts[0] == "datasets" and len(parts) == 1:
        return await _readdir_datasets(accessor, virtual_key, index, prefix)

    if parts[0] == "datasets" and len(parts) == 2:
        return [
            f"{prefix}/datasets/{parts[1]}/items.jsonl",
            f"{prefix}/datasets/{parts[1]}/runs",
        ]

    if (parts[0] == "datasets" and len(parts) == 3 and parts[2] == "runs"):
        return await _readdir_dataset_runs(
            accessor,
            parts[1],
            virtual_key,
            index,
            prefix,
        )

    raise enoent(virtual)


async def _readdir_traces(
    accessor: LangfuseAccessor,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    limit = accessor.config.default_trace_limit
    traces = await fetch_traces(accessor.api, limit=limit)
    entries = []
    names = []
    for t in traces:
        trace_id = t.get("id", "")
        filename = f"{trace_id}.json"
        entry = IndexEntry(
            id=trace_id,
            name=trace_id,
            resource_type="langfuse/trace",
            vfs_name=filename,
        )
        entries.append((filename, entry))
        names.append(f"{prefix}/traces/{filename}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_sessions(
    accessor: LangfuseAccessor,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    sessions = await fetch_sessions(accessor.api)
    entries = []
    names = []
    for s in sessions:
        session_id = s.get("id", "")
        entry = IndexEntry(
            id=session_id,
            name=session_id,
            resource_type="langfuse/session",
            vfs_name=session_id,
        )
        entries.append((session_id, entry))
        names.append(f"{prefix}/sessions/{session_id}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_session_traces(
    accessor: LangfuseAccessor,
    session_id: str,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    limit = accessor.config.default_trace_limit
    traces = await fetch_traces(
        accessor.api,
        session_id=session_id,
        limit=limit,
    )
    entries = []
    names = []
    for t in traces:
        trace_id = t.get("id", "")
        filename = f"{trace_id}.json"
        entry = IndexEntry(
            id=trace_id,
            name=trace_id,
            resource_type="langfuse/trace",
            vfs_name=filename,
        )
        entries.append((filename, entry))
        names.append(f"{prefix}/sessions/{session_id}/{filename}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_prompts(
    accessor: LangfuseAccessor,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    prompts = await fetch_prompts(accessor.api)
    seen: set[str] = set()
    entries = []
    names = []
    for p in prompts:
        prompt_name = p.get("name", "")
        if prompt_name in seen:
            continue
        seen.add(prompt_name)
        entry = IndexEntry(
            id=prompt_name,
            name=prompt_name,
            resource_type="langfuse/prompt",
            vfs_name=prompt_name,
        )
        entries.append((prompt_name, entry))
        names.append(f"{prefix}/prompts/{prompt_name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_prompt_versions(
    accessor: LangfuseAccessor,
    prompt_name: str,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    prompts = await fetch_prompts(accessor.api)
    entries = []
    names = []
    for p in prompts:
        if p.get("name") != prompt_name:
            continue
        version = p.get("version", 0)
        filename = f"{version}.json"
        entry = IndexEntry(
            id=f"{prompt_name}/{version}",
            name=str(version),
            resource_type="langfuse/prompt_version",
            vfs_name=filename,
        )
        entries.append((filename, entry))
        names.append(f"{prefix}/prompts/{prompt_name}/{filename}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_datasets(
    accessor: LangfuseAccessor,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    datasets = await fetch_datasets(accessor.api)
    entries = []
    names = []
    for d in datasets:
        dataset_name = d.get("name", "")
        entry = IndexEntry(
            id=dataset_name,
            name=dataset_name,
            resource_type="langfuse/dataset",
            vfs_name=dataset_name,
        )
        entries.append((dataset_name, entry))
        names.append(f"{prefix}/datasets/{dataset_name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_dataset_runs(
    accessor: LangfuseAccessor,
    dataset_name: str,
    virtual_key: str,
    index: IndexCacheStore | None,
    prefix: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    runs = await fetch_dataset_runs(accessor.api, dataset_name)
    entries = []
    names = []
    for r in runs:
        run_name = r.get("name", "")
        filename = f"{run_name}.jsonl"
        entry = IndexEntry(
            id=run_name,
            name=run_name,
            resource_type="langfuse/dataset_run",
            vfs_name=filename,
        )
        entries.append((filename, entry))
        names.append(f"{prefix}/datasets/{dataset_name}/runs/{filename}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names
