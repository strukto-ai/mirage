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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.langfuse._client import (fetch_dataset_items,
                                          fetch_dataset_runs, fetch_datasets,
                                          fetch_prompts, fetch_sessions,
                                          fetch_traces)
from mirage.core.langfuse.render import jsonl_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of

TOP_LEVEL_DIRS = ["traces", "sessions", "prompts", "datasets"]


async def readdir(
    accessor: LangfuseAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    """List directory contents.

    Args:
        accessor (LangfuseAccessor): langfuse accessor.
        path_spec (PathSpec): resource-relative path.
        index (IndexCacheStore): index cache.
        prefix (str): mount prefix for virtual index keys.
    """
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
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
        return await _readdir_dataset(
            accessor,
            parts[1],
            virtual_key,
            index,
            prefix,
        )

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
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    limit = accessor.config.default_trace_limit
    traces = await fetch_traces(
        accessor.api,
        limit=limit,
        from_timestamp=accessor.config.default_from_timestamp,
    )
    # The list endpoint returns trace summaries while a read renders the
    # full trace with its observations, so a size here would cost one
    # fetch_trace per entry. Traces and prompts stay size-unknown until a
    # read hydrates them; the dataset .jsonl files below are sized
    # because their listing already carries every item.
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
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_sessions(
    accessor: LangfuseAccessor,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
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
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_session_traces(
    accessor: LangfuseAccessor,
    session_id: str,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    limit = accessor.config.default_trace_limit
    traces = await fetch_traces(
        accessor.api,
        session_id=session_id,
        limit=limit,
        from_timestamp=accessor.config.default_from_timestamp,
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
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_prompts(
    accessor: LangfuseAccessor,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
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
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_prompt_versions(
    accessor: LangfuseAccessor,
    prompt_name: str,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    prompts = await fetch_prompts(accessor.api)
    entries = []
    names = []
    for p in prompts:
        if p.get("name") != prompt_name:
            continue
        # The list endpoint returns PromptMeta, which carries every version
        # of a prompt in a `versions` array; there is no scalar `version`.
        for version in sorted(p.get("versions", [])):
            filename = f"{version}.json"
            entry = IndexEntry(
                id=f"{prompt_name}/{version}",
                name=str(version),
                resource_type="langfuse/prompt_version",
                vfs_name=filename,
            )
            entries.append((filename, entry))
            names.append(f"{prefix}/prompts/{prompt_name}/{filename}")
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_datasets(
    accessor: LangfuseAccessor,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
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
    await index.set_dir(virtual_key, entries)
    return names


async def _readdir_dataset(
    accessor: LangfuseAccessor,
    dataset_name: str,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    # One dataset_items call per dataset directory actually entered: the
    # dataset listing carries no item payloads, so items.jsonl can only be
    # sized here, and only for datasets the caller opens.
    items = await fetch_dataset_items(accessor.api, dataset_name)
    entries = [
        ("items.jsonl",
         IndexEntry(
             id=f"{dataset_name}/items",
             name="items.jsonl",
             resource_type="langfuse/dataset_items",
             vfs_name="items.jsonl",
             size=len(jsonl_bytes(items)),
         )),
        ("runs",
         IndexEntry(
             id=f"{dataset_name}/runs",
             name="runs",
             resource_type="langfuse/dataset_runs_dir",
             vfs_name="runs",
         )),
    ]
    await index.set_dir(virtual_key, entries)
    return [f"{prefix}/datasets/{dataset_name}/{name}" for name, _ in entries]


async def _readdir_dataset_runs(
    accessor: LangfuseAccessor,
    dataset_name: str,
    virtual_key: str,
    index: IndexCacheStore,
    prefix: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    runs = await fetch_dataset_runs(accessor.api, dataset_name)
    entries = []
    names = []
    for r in runs:
        run_name = r.get("name", "")
        filename = f"{run_name}.jsonl"
        # The listing already carries the run document read() renders, so
        # each run file's exact size is free here.
        entry = IndexEntry(
            id=run_name,
            name=run_name,
            resource_type="langfuse/dataset_run",
            vfs_name=filename,
            size=len(jsonl_bytes([r])),
        )
        entries.append((filename, entry))
        names.append(f"{prefix}/datasets/{dataset_name}/runs/{filename}")
    await index.set_dir(virtual_key, entries)
    return names
