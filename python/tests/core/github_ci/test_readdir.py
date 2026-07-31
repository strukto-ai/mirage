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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github_ci.readdir import readdir
from mirage.core.github_ci.render import ci_json_bytes
from mirage.resource.github_ci.config import GitHubCIConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return GitHubCIAccessor(GitHubCIConfig(token="t", owner="o", repo="r"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def _spec(original: str) -> PathSpec:
    return PathSpec(virtual=original,
                    directory=original,
                    resource_path=original.strip("/"))


@pytest.mark.asyncio
async def test_readdir_workflows_stores_rendered_size(accessor, index):
    wf = {"id": 7, "name": "CI", "state": "active", "updated_at": "2026-01-01"}
    with patch("mirage.core.github_ci.readdir.list_workflows",
               new_callable=AsyncMock,
               return_value=[wf]):
        await readdir(accessor, _spec("/workflows"), index)
    lookup = await index.get("/workflows/CI_7.json")
    assert lookup.entry is not None
    assert lookup.entry.size == len(ci_json_bytes(wf))


@pytest.mark.asyncio
async def test_readdir_runs_seeds_run_dir_with_sized_run_json(accessor, index):
    run = {"id": 11, "name": "CI", "status": "completed", "updated_at": "u"}
    with patch("mirage.core.github_ci.readdir.list_runs",
               new_callable=AsyncMock,
               return_value=[run]):
        await readdir(accessor, _spec("/runs"), index)
    listing = await index.list_dir("/runs/CI_11")
    assert listing.entries == [
        "/runs/CI_11/run.json",
        "/runs/CI_11/jobs",
        "/runs/CI_11/annotations.jsonl",
        "/runs/CI_11/artifacts",
    ]
    lookup = await index.get("/runs/CI_11/run.json")
    assert lookup.entry is not None
    assert lookup.entry.size == len(ci_json_bytes(run))
    annotations = await index.get("/runs/CI_11/annotations.jsonl")
    assert annotations.entry is not None
    assert annotations.entry.size is None


@pytest.mark.asyncio
async def test_readdir_jobs_stores_rendered_json_size_only(accessor, index):
    run = {"id": 11, "name": "CI", "updated_at": "u"}
    job = {"id": 21, "name": "build", "completed_at": "c", "steps": []}
    with patch("mirage.core.github_ci.readdir.list_runs",
               new_callable=AsyncMock,
               return_value=[run]):
        await readdir(accessor, _spec("/runs"), index)
    with patch("mirage.core.github_ci.readdir.list_jobs_for_run",
               new_callable=AsyncMock,
               return_value=[job]):
        await readdir(accessor, _spec("/runs/CI_11/jobs"), index)
    json_lookup = await index.get("/runs/CI_11/jobs/build_21.json")
    assert json_lookup.entry is not None
    assert json_lookup.entry.size == len(ci_json_bytes(job))
    log_lookup = await index.get("/runs/CI_11/jobs/build_21.log")
    assert log_lookup.entry is not None
    assert log_lookup.entry.size is None
