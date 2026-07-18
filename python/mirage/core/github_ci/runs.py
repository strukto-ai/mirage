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

from datetime import datetime, timedelta, timezone
from typing import Any

from mirage.core.github_ci._client import (ci_get, ci_get_bytes,
                                           ci_get_paginated)
from mirage.resource.github_ci.config import GitHubCIConfig


async def list_runs(config: GitHubCIConfig,
                    days: int = 30) -> list[dict[str, Any]]:
    since = (datetime.now(timezone.utc) -
             timedelta(days=days)).strftime("%Y-%m-%d")
    return await ci_get_paginated(
        config.token,
        "/repos/{owner}/{repo}/actions/runs",
        list_key="workflow_runs",
        params={"created": f">={since}"},
        max_results=config.max_runs,
        owner=config.owner,
        repo=config.repo,
    )


async def get_run(config: GitHubCIConfig, run_id: str) -> dict[str, Any]:
    return await ci_get(
        config.token,
        "/repos/{owner}/{repo}/actions/runs/{run_id}",
        owner=config.owner,
        repo=config.repo,
        run_id=run_id,
    )


async def list_jobs_for_run(config: GitHubCIConfig,
                            run_id: str) -> list[dict[str, Any]]:
    return await ci_get_paginated(
        config.token,
        "/repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
        list_key="jobs",
        owner=config.owner,
        repo=config.repo,
        run_id=run_id,
    )


async def get_job(config: GitHubCIConfig, job_id: str) -> dict[str, Any]:
    return await ci_get(
        config.token,
        "/repos/{owner}/{repo}/actions/jobs/{job_id}",
        owner=config.owner,
        repo=config.repo,
        job_id=job_id,
    )


async def download_job_log(config: GitHubCIConfig, job_id: str) -> bytes:
    return await ci_get_bytes(
        config.token,
        "/repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        owner=config.owner,
        repo=config.repo,
        job_id=job_id,
    )
