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

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, TypeVar, cast

from langfuse.api.client import AsyncLangfuseAPI
from langfuse.api.core.api_error import ApiError
from langfuse.api.core.pydantic_utilities import UniversalBaseModel

from mirage.errors.fs import enoent

T = TypeVar("T")


async def fetch_or_enoent(pending: Awaitable[T], virtual: str) -> T:
    """Await a Langfuse fetch, translating a 404 into ENOENT.

    Every other status stays an ApiError: only "this resource does not exist"
    is a filesystem-level missing file.

    Args:
        pending (Awaitable[T]): pending Langfuse API call.
        virtual (str): virtual path named in the ENOENT message.

    Returns:
        T: the API result.

    Raises:
        FileNotFoundError: Langfuse reported 404 for this resource.
    """
    try:
        return await pending
    except ApiError as exc:
        if exc.status_code == 404:
            raise enoent(virtual) from exc
        raise


# mode="json" is load-bearing: the SDK's models only apply their field
# aliases (createdAt, userId, expectedOutput, ...) and datetime serialization
# inside a json-mode serializer. A python-mode dump returns snake_case keys,
# and by_alias does not restore them. The cost is that timestamps carry
# microsecond precision where the API sent milliseconds, a rendering
# divergence from TypeScript that is documented rather than papered over with
# string rewriting that could alter trace content.
def _to_dict(obj: UniversalBaseModel) -> dict[str, Any]:
    if hasattr(obj, "model_dump"):
        return cast(dict[str, Any], _wire_numbers(obj.model_dump(mode="json")))
    if hasattr(obj, "dict"):
        return cast(dict[str, Any], _wire_numbers(obj.dict()))
    return vars(obj)


# The SDK's float fields (latency, totalCost, a score's value, ...) turn the
# API's 1 into 1.0. Langfuse serves JSON from Node, whose JSON.stringify
# never writes a fraction on an integral number below 1e21, so such a float
# goes back to the integer the API sent.
def _wire_numbers(value: Any) -> Any:
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return int(value)
    if isinstance(value, dict):
        return {key: _wire_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_wire_numbers(item) for item in value]
    return value


# A root observation stands for its trace: v4 keeps no trace entity, and
# the root carries the trace's name, user, session and tags.
TRACE_FIELDS = "core,basic"
OBSERVATION_FIELDS = (
    "core,basic,time,io,metadata,model,usage,prompt,metrics,trace_context"
)
SCORE_FIELDS = "details,subject"
EXPERIMENT_FIELDS = "core,metadata,scores"
# The experiments endpoint requires a lower bound; the epoch asks for all.
EXPERIMENTS_FROM = datetime(1970, 1, 1, tzinfo=UTC)
PAGE_SIZE = 100


async def _collect(
    page: Callable[..., Awaitable[Any]],
    limit: int | None = None,
    **kwargs: Any,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    while limit is None or len(out) < limit:
        size = PAGE_SIZE if limit is None else min(PAGE_SIZE, limit - len(out))
        result = await page(limit=size, cursor=cursor, **kwargs)
        out.extend(_to_dict(row) for row in result.data)
        cursor = result.meta.cursor
        if not result.data or not cursor:
            break
    return out


async def fetch_traces(
    api: AsyncLangfuseAPI,
    limit: int = 100,
    session_id: str | None = None,
    from_timestamp: str | None = None,
) -> list[dict[str, Any]]:
    """The root observations of the newest traces, one or more per trace.

    Args:
        api (AsyncLangfuseAPI): the Langfuse API client.
        limit (int): the most root observations to return.
        session_id (str | None): only this session's traces.
        from_timestamp (str | None): ISO 8601 lower bound on start time.

    Returns:
        list[dict[str, Any]]: root observations, newest first.
    """
    kwargs: dict[str, Any] = {
        "fields": TRACE_FIELDS,
        "is_root_observation": True,
    }
    if session_id:
        kwargs["session_id"] = session_id
    if from_timestamp:
        kwargs["from_start_time"] = datetime.fromisoformat(
            from_timestamp.replace("Z", "+00:00")
        )
    return await _collect(api.observations.get_many, limit, **kwargs)


def _start_time(observation: dict[str, Any]) -> str:
    return observation.get("startTime") or ""


async def fetch_trace(api: AsyncLangfuseAPI, trace_id: str) -> dict[str, Any]:
    """One trace: its root observation, the rest and its scores.

    Args:
        api (AsyncLangfuseAPI): the Langfuse API client.
        trace_id (str): the trace id.

    Returns:
        dict[str, Any]: the root observation with ``observations`` and
        ``scores`` added.

    Raises:
        ApiError: 404 when the trace has no observations.
    """
    observations = await _collect(
        api.observations.get_many,
        trace_id=trace_id,
        fields=OBSERVATION_FIELDS,
    )
    if not observations:
        raise ApiError(
            status_code=404, body={"message": f"trace {trace_id} not found"}
        )
    roots = [o for o in observations if o.get("isRootObservation")]
    root = min(roots or observations, key=_start_time)
    scores = await _collect(
        api.scores.get_many, trace_id=trace_id, fields=SCORE_FIELDS
    )
    return {
        **root,
        "observations": [o for o in observations if o is not root],
        "scores": scores,
    }


async def fetch_sessions(
    api: AsyncLangfuseAPI,
    limit: int = 100,
    from_timestamp: str | None = None,
) -> list[str]:
    """The sessions of the newest traces, newest first.

    Args:
        api (AsyncLangfuseAPI): the Langfuse API client.
        limit (int): the most traces to look through.
        from_timestamp (str | None): ISO 8601 lower bound on start time.

    Returns:
        list[str]: distinct session ids.
    """
    roots = await fetch_traces(api, limit=limit, from_timestamp=from_timestamp)
    return list(
        dict.fromkeys(r["sessionId"] for r in roots if r.get("sessionId"))
    )


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
) -> list[dict[str, Any]]:
    """The experiments run on a dataset.

    Args:
        api (AsyncLangfuseAPI): the Langfuse API client.
        dataset_name (str): the dataset's name.

    Returns:
        list[dict[str, Any]]: experiments, latest activity first.
    """
    dataset = await api.datasets.get(dataset_name)
    return await _collect(
        api.experiments.list,
        from_start_time=EXPERIMENTS_FROM,
        dataset_id=dataset.id,
        fields=EXPERIMENT_FIELDS,
    )
