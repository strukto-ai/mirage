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

from mem0 import AsyncMemoryClient
from mem0.client.types import GetAllMemoryOptions, SearchMemoryOptions
from mem0.exceptions import MemoryNotFoundError

from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def get_all_memories(
    client: AsyncMemoryClient,
    filters: dict[str, str],
    page_size: int = 100,
) -> list[dict[str, Any]]:
    """Fetch all memories for a scope, following pagination.

    Args:
        client (AsyncMemoryClient): mem0 async client.
        filters (dict): mem0 entity filter, e.g. {"user_id": "alex"}.
        page_size (int): page size per request.
    """
    results: list[dict[str, Any]] = []
    page = 1
    while True:
        options = GetAllMemoryOptions(
            filters=filters,
            page=page,
            page_size=page_size,
        )
        resp = await client.get_all(options=options)
        batch = resp.get("results", [])
        results.extend(batch)
        if not resp.get("next") or not batch:
            break
        page += 1
    return results


async def get_memory(client: AsyncMemoryClient, memory_id: str,
                     path: PathSpec) -> dict[str, Any]:
    """Fetch one memory by id.

    A deleted or unknown memory id 404s; filesystem callers need ENOENT so
    ``test -e``, ``cat`` and friends report "No such file or directory"
    instead of leaking the provider error.

    Args:
        client (AsyncMemoryClient): mem0 async client.
        memory_id (str): memory id.
        path (PathSpec): virtual path the id came from, for the error.
    """
    try:
        return await client.get(memory_id)
    except MemoryNotFoundError as exc:
        raise enoent(path) from exc


async def search_memories(
    client: AsyncMemoryClient,
    query: str,
    filters: dict[str, str],
    top_k: int = 10,
    threshold: float = 0.0,
) -> list[dict[str, Any]]:
    """Semantic search within a scope.

    Args:
        client (AsyncMemoryClient): mem0 async client.
        query (str): search query.
        filters (dict): mem0 entity filter.
        top_k (int): number of results.
        threshold (float): minimum similarity score.
    """
    options = SearchMemoryOptions(
        filters=filters,
        top_k=top_k,
        threshold=threshold,
    )
    resp = await client.search(query, options=options)
    return resp.get("results", [])
