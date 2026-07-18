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

from langfuse.api.client import AsyncLangfuseAPI


def _to_dict(obj) -> dict[str, Any]:
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    if hasattr(obj, "dict"):
        return obj.dict()
    return vars(obj)


async def fetch_traces(
    api: AsyncLangfuseAPI,
    limit: int = 100,
    name: str | None = None,
    user_id: str | None = None,
    session_id: str | None = None,
    order_by: str | None = None,
) -> list[dict[str, Any]]:
    kwargs: dict[str, Any] = {"limit": limit}
    if name:
        kwargs["name"] = name
    if user_id:
        kwargs["user_id"] = user_id
    if session_id:
        kwargs["session_id"] = session_id
    if order_by:
        kwargs["order_by"] = order_by
    result = await api.trace.list(**kwargs)
    return [_to_dict(t) for t in result.data]


async def fetch_trace(api: AsyncLangfuseAPI, trace_id: str) -> dict[str, Any]:
    result = await api.trace.get(trace_id)
    return _to_dict(result)


async def fetch_sessions(
    api: AsyncLangfuseAPI,
    limit: int = 100,
) -> list[dict[str, Any]]:
    result = await api.sessions.list(limit=limit)
    return [_to_dict(s) for s in result.data]


async def fetch_prompts(api: AsyncLangfuseAPI) -> list[dict[str, Any]]:
    result = await api.prompts.list()
    return [_to_dict(p) for p in result.data]


async def fetch_prompt(
    api: AsyncLangfuseAPI,
    name: str,
    version: int | None = None,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"prompt_name": name}
    if version is not None:
        kwargs["version"] = version
    result = await api.prompts.get(**kwargs)
    return _to_dict(result)


async def fetch_datasets(api: AsyncLangfuseAPI) -> list[dict[str, Any]]:
    result = await api.datasets.list()
    return [_to_dict(d) for d in result.data]


async def fetch_dataset_items(
    api: AsyncLangfuseAPI,
    dataset_name: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    result = await api.dataset_items.list(
        dataset_name=dataset_name,
        limit=limit,
    )
    return [_to_dict(item) for item in result.data]


async def fetch_dataset_runs(
    api: AsyncLangfuseAPI,
    dataset_name: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    result = await api.datasets.get_runs(
        dataset_name=dataset_name,
        limit=limit,
    )
    return [_to_dict(r) for r in result.data]
