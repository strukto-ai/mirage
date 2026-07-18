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

from mirage.core.github_ci._client import ci_get_bytes, ci_get_paginated
from mirage.resource.github_ci.config import GitHubCIConfig


async def list_artifacts(config: GitHubCIConfig,
                         run_id: str) -> list[dict[str, Any]]:
    return await ci_get_paginated(
        config.token,
        "/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
        list_key="artifacts",
        owner=config.owner,
        repo=config.repo,
        run_id=run_id,
    )


async def download_artifact(config: GitHubCIConfig, artifact_id: str) -> bytes:
    return await ci_get_bytes(
        config.token,
        "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip",
        owner=config.owner,
        repo=config.repo,
        artifact_id=artifact_id,
    )
