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

from collections.abc import Callable
from typing import Any

from mirage.accessor.github import GitHubAccount
from mirage.core.github.client import github_request


async def github_pages(
    account: GitHubAccount,
    path: str,
    *,
    params: dict[str, str] | None = None,
    limit: int = 30,
    key: str | None = None,
    include: Callable[[dict[str, Any]], bool] | None = None,
) -> list[dict[str, Any]]:
    """Fetch a bounded REST list using GitHub's page/per_page contract."""
    if limit < 1:
        return []
    rows: list[dict[str, Any]] = []
    page = 1
    size = min(100, limit)
    while len(rows) < limit:
        query = {**(params or {}), "per_page": str(size), "page": str(page)}
        data = await github_request(account, "GET", path, params=query)
        payload: Any = (
            data.get(key, []) if key and isinstance(data, dict) else data
        )
        batch = payload if isinstance(payload, list) else []
        candidates = (item for item in batch if isinstance(item, dict))
        rows.extend(
            item for item in candidates if include is None or include(item)
        )
        if len(batch) < size:
            break
        page += 1
    return rows[:limit]
