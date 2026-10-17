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
from mirage.core.github.release import (
    create_release,
    get_latest_release,
    get_release,
)
from mirage.core.github.repo import RepoRef


@pytest.mark.asyncio
async def test_create_release_posts_the_typed_body(monkeypatch):
    calls = []

    async def request(account, method, path, body):
        calls.append((method, path, body))
        return {"tag_name": "v1"}

    monkeypatch.setitem(create_release.__globals__, "github_request", request)
    body = {"tag_name": "v1", "draft": False}

    assert await create_release(
        GitHubAccount(GhConfig(token="t")), RepoRef("o", "r"), body
    ) == {"tag_name": "v1"}
    assert calls == [("POST", "/repos/o/r/releases", body)]


@pytest.mark.asyncio
async def test_get_latest_release_uses_the_authoritative_endpoint(monkeypatch):
    calls = []

    async def request(account, method, path):
        calls.append((method, path))
        return {"tag_name": "v1"}

    monkeypatch.setitem(
        get_latest_release.__globals__, "github_request", request
    )

    assert await get_latest_release(
        GitHubAccount(GhConfig(token="t")), RepoRef("o", "r")
    ) == {"tag_name": "v1"}
    assert calls == [("GET", "/repos/o/r/releases/latest")]


@pytest.mark.asyncio
async def test_get_release_encodes_the_tag_path_segment(monkeypatch):
    calls = []

    async def request(account, method, path):
        calls.append(path)
        return {"tag_name": "v1#hot"}

    monkeypatch.setitem(get_release.__globals__, "github_request", request)

    assert await get_release(
        GitHubAccount(GhConfig(token="t")), RepoRef("o", "r"), "v1#hot"
    ) == {"tag_name": "v1#hot"}
    assert calls == ["/repos/o/r/releases/tags/v1%23hot"]
