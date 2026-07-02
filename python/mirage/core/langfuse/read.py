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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.langfuse._client import (fetch_dataset_items,
                                          fetch_dataset_runs, fetch_prompt,
                                          fetch_trace)
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


def _json_bytes(data: dict) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode()


def _jsonl_bytes(items: list[dict]) -> bytes:
    if not items:
        return b""
    lines = [
        json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        for item in items
    ]
    return ("\n".join(lines) + "\n").encode()


async def read(
    accessor: LangfuseAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    """Read a file as bytes.

    Args:
        accessor (LangfuseAccessor): langfuse accessor.
        path (str): resource-relative path.
        index (IndexCacheStore | None): index cache.
        prefix (str): mount prefix for virtual index keys.
    """
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path

    if any(p.startswith(".") for p in key.split("/")):
        raise enoent(virtual)

    parts = key.split("/")

    if parts[0] == "traces" and len(parts) == 2 and parts[1].endswith(".json"):
        trace_id = parts[1].removesuffix(".json")
        data = await fetch_trace(accessor.api, trace_id)
        return _json_bytes(data)

    if (parts[0] == "sessions" and len(parts) == 3
            and parts[2].endswith(".json")):
        trace_id = parts[2].removesuffix(".json")
        data = await fetch_trace(accessor.api, trace_id)
        return _json_bytes(data)

    if (parts[0] == "prompts" and len(parts) == 3
            and parts[2].endswith(".json")):
        prompt_name = parts[1]
        version = int(parts[2].removesuffix(".json"))
        data = await fetch_prompt(accessor.api, prompt_name, version)
        return _json_bytes(data)

    if (parts[0] == "datasets" and len(parts) == 3
            and parts[2] == "items.jsonl"):
        dataset_name = parts[1]
        items = await fetch_dataset_items(accessor.api, dataset_name)
        return _jsonl_bytes(items)

    if (parts[0] == "datasets" and len(parts) == 4 and parts[2] == "runs"
            and parts[3].endswith(".jsonl")):
        dataset_name = parts[1]
        run_name = parts[3].removesuffix(".jsonl")
        runs = await fetch_dataset_runs(accessor.api, dataset_name)
        matched = [r for r in runs if r.get("name") == run_name]
        if not matched:
            raise enoent(virtual)
        return _json_bytes(matched[0])

    raise enoent(virtual)
