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

import pytest

from mirage.accessor.github import GitHubAccount
from mirage.core.github.config import GhConfig
from mirage.core.github.paginate import github_pages


@pytest.mark.asyncio
async def test_limit_counts_only_included_rows(monkeypatch):
    pages = {
        "1": [{"number": 1, "pull_request": {}}, {"number": 2}, {"number": 3}],
        "2": [{"number": 4}],
    }
    seen = []
    account = GitHubAccount(GhConfig(token="t"))

    async def request(handle, method, path, params=None):
        assert handle is account
        seen.append(params)
        return pages[params["page"]]

    monkeypatch.setitem(github_pages.__globals__, "github_request", request)

    rows = await github_pages(
        account,
        "/repos/o/r/issues",
        limit=3,
        include=lambda row: "pull_request" not in row,
    )

    assert rows == [{"number": 2}, {"number": 3}, {"number": 4}]
    assert [params["page"] for params in seen] == ["1", "2"]
    assert [params["per_page"] for params in seen] == ["3", "3"]
