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

from typing import cast

from mirage.core.github_ci._client import ci_get
from mirage.resource.github_ci.config import GitHubCIConfig


async def list_annotations(config: GitHubCIConfig,
                           check_run_id: str) -> list[dict]:
    return cast(
        list[dict], await ci_get(
            config.token,
            "/repos/{owner}/{repo}/check-runs/{check_run_id}/annotations",
            owner=config.owner,
            repo=config.repo,
            check_run_id=check_run_id,
        ))
