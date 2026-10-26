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
from unittest.mock import AsyncMock, MagicMock

import pytest
from langfuse.api import (
    Dataset,
    ExperimentsResponse,
    GetScoresV3Response,
    ObservationsV2Response,
)
from langfuse.api.core.api_error import ApiError
from langfuse.api.core.pydantic_utilities import parse_obj_as

from mirage.core.langfuse.client import (
    fetch_dataset_runs,
    fetch_sessions,
    fetch_trace,
)


def _observations(rows, cursor=None):
    meta = {} if cursor is None else {"cursor": cursor}
    return parse_obj_as(ObservationsV2Response, {"data": rows, "meta": meta})


def _scores(rows):
    return parse_obj_as(
        GetScoresV3Response, {"data": rows, "meta": {"limit": 100}}
    )


ROOT = {
    "id": "root",
    "traceId": "t1",
    "startTime": "2026-01-01T00:00:00.000Z",
    "projectId": "p",
    "type": "SPAN",
    "isRootObservation": True,
    "sessionId": "s1",
    "latency": 1,
    "totalCost": 0.25,
    "metadata": {"ratio": 0.5, "count": 2},
}
CHILD = {
    "id": "child",
    "traceId": "t1",
    "startTime": "2026-01-01T00:00:01.000Z",
    "projectId": "p",
    "type": "GENERATION",
    "parentObservationId": "root",
    "isRootObservation": False,
}
SCORE = {
    "id": "score-1",
    "projectId": "p",
    "name": "helpfulness",
    "dataType": "NUMERIC",
    "value": 0.75,
    "source": "API",
    "timestamp": "2026-01-01T00:00:00.000Z",
    "environment": "default",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
}


@pytest.mark.asyncio
async def test_fetch_trace_renders_the_root_with_the_rest_and_scores():
    api = MagicMock()
    api.observations.get_many = AsyncMock(
        return_value=_observations([CHILD, ROOT])
    )
    api.scores.get_many = AsyncMock(return_value=_scores([SCORE]))

    data = await fetch_trace(api, "t1")

    assert data["id"] == "root"
    assert [o["id"] for o in data["observations"]] == ["child"]
    assert [s["id"] for s in data["scores"]] == ["score-1"]
    assert api.observations.get_many.await_args.kwargs["trace_id"] == "t1"
    assert api.scores.get_many.await_args.kwargs["trace_id"] == "t1"


@pytest.mark.asyncio
async def test_fetch_trace_keeps_the_api_numbers():
    api = MagicMock()
    api.observations.get_many = AsyncMock(return_value=_observations([ROOT]))
    api.scores.get_many = AsyncMock(return_value=_scores([]))

    data = await fetch_trace(api, "t1")

    assert json.dumps(data["latency"]) == "1"
    assert json.dumps(data["totalCost"]) == "0.25"
    assert data["metadata"] == {"ratio": 0.5, "count": 2}


@pytest.mark.asyncio
async def test_fetch_trace_follows_the_cursor():
    api = MagicMock()
    api.observations.get_many = AsyncMock(
        side_effect=[
            _observations([ROOT], cursor="next"),
            _observations([CHILD]),
        ]
    )
    api.scores.get_many = AsyncMock(return_value=_scores([]))

    data = await fetch_trace(api, "t1")

    assert [o["id"] for o in data["observations"]] == ["child"]
    calls = api.observations.get_many.await_args_list
    assert calls[1].kwargs["cursor"] == "next"


@pytest.mark.asyncio
async def test_fetch_trace_without_observations_is_a_404():
    api = MagicMock()
    api.observations.get_many = AsyncMock(return_value=_observations([]))

    with pytest.raises(ApiError) as caught:
        await fetch_trace(api, "gone")
    assert caught.value.status_code == 404


@pytest.mark.asyncio
async def test_fetch_sessions_lists_distinct_sessions_of_root_observations():
    rows = [
        {**ROOT, "traceId": "t1", "sessionId": "s1"},
        {**ROOT, "traceId": "t2", "sessionId": ""},
        {**ROOT, "traceId": "t3", "sessionId": "s1"},
        {**ROOT, "traceId": "t4", "sessionId": "s2"},
    ]
    api = MagicMock()
    api.observations.get_many = AsyncMock(return_value=_observations(rows))

    assert await fetch_sessions(api) == ["s1", "s2"]
    assert api.observations.get_many.await_args.kwargs["is_root_observation"]


@pytest.mark.asyncio
async def test_fetch_dataset_runs_lists_experiments_by_dataset_id():
    api = MagicMock()
    api.datasets.get = AsyncMock(
        return_value=parse_obj_as(
            Dataset,
            {
                "id": "ds-1",
                "name": "eval-basic",
                "metadata": None,
                "projectId": "p",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
            },
        )
    )
    api.experiments.list = AsyncMock(
        return_value=parse_obj_as(
            ExperimentsResponse,
            {
                "data": [
                    {
                        "id": "e1",
                        "name": "run-alpha",
                        "datasetId": "ds-1",
                        "startTime": "2026-01-01T00:00:00.000Z",
                        "endTime": "2026-01-01T00:00:01.000Z",
                        "itemCount": 1,
                    }
                ],
                "meta": {},
            },
        )
    )

    runs = await fetch_dataset_runs(api, "eval-basic")

    assert [r["name"] for r in runs] == ["run-alpha"]
    kwargs = api.experiments.list.await_args.kwargs
    assert kwargs["dataset_id"] == "ds-1"
    assert "filter" not in kwargs

    await fetch_dataset_runs(api, "eval-basic", "run,alpha")

    kwargs = api.experiments.list.await_args.kwargs
    assert json.loads(kwargs["filter"]) == [
        {
            "type": "string",
            "column": "name",
            "operator": "=",
            "value": "run,alpha",
        }
    ]
