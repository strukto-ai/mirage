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

import pytest

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.github_ci import COMMANDS
from mirage.core.github_ci import _client as ci_client
from mirage.core.github_ci.runs import list_runs
from mirage.io.stream import materialize
from mirage.resource.github_ci.config import GitHubCIConfig
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


class _MockResponse:

    def __init__(self, data: Any):
        self._data = data

    def raise_for_status(self) -> None:
        return None

    async def json(self) -> Any:
        return self._data

    async def __aenter__(self) -> "_MockResponse":
        return self

    async def __aexit__(self, *_a: object) -> None:
        return None


class _MockSession:

    def __init__(self, list_key: str, total: int, per_page: int = 100):
        self.list_key = list_key
        self.total = total
        self.per_page = per_page
        self.calls: list[dict[str, str]] = []

    def get(self,
            _url: str,
            headers: Any = None,
            params: Any = None) -> _MockResponse:
        params = dict(params or {})
        self.calls.append(params)
        page = int(params.get("page", 1))
        per_page = int(params.get("per_page", self.per_page))
        start = (page - 1) * per_page
        end = min(start + per_page, self.total)
        batch = [{"id": i, "name": f"item-{i}"} for i in range(start, end)]
        return _MockResponse({self.list_key: batch})

    async def __aenter__(self) -> "_MockSession":
        return self

    async def __aexit__(self, *_a: object) -> None:
        return None


def _patch_session(monkeypatch: pytest.MonkeyPatch,
                   session: _MockSession) -> None:
    monkeypatch.setattr(ci_client.aiohttp, "ClientSession", lambda: session)


def test_config_default_max_runs():
    cfg = GitHubCIConfig(token="t", owner="o", repo="r")
    assert cfg.max_runs == 300


def test_config_override_max_runs():
    cfg = GitHubCIConfig(token="t", owner="o", repo="r", max_runs=42)
    assert cfg.max_runs == 42


@pytest.mark.asyncio
async def test_paginator_truncates_to_max_results(monkeypatch):
    session = _MockSession("workflow_runs", total=1000)
    _patch_session(monkeypatch, session)
    out = await ci_client.ci_get_paginated(
        "tok",
        "/repos/{owner}/{repo}/actions/runs",
        list_key="workflow_runs",
        max_results=300,
        owner="o",
        repo="r",
    )
    assert len(out) == 300
    assert len(session.calls) == 3


@pytest.mark.asyncio
async def test_paginator_no_max_returns_all(monkeypatch):
    session = _MockSession("workflow_runs", total=250)
    _patch_session(monkeypatch, session)
    out = await ci_client.ci_get_paginated(
        "tok",
        "/repos/{owner}/{repo}/actions/runs",
        list_key="workflow_runs",
        owner="o",
        repo="r",
    )
    assert len(out) == 250


@pytest.mark.asyncio
async def test_paginator_stops_when_batch_short(monkeypatch):
    session = _MockSession("workflow_runs", total=50)
    _patch_session(monkeypatch, session)
    out = await ci_client.ci_get_paginated(
        "tok",
        "/repos/{owner}/{repo}/actions/runs",
        list_key="workflow_runs",
        max_results=300,
        owner="o",
        repo="r",
    )
    assert len(out) == 50
    assert len(session.calls) == 1


@pytest.mark.asyncio
async def test_list_runs_uses_config_max_runs(monkeypatch):
    session = _MockSession("workflow_runs", total=1000)
    _patch_session(monkeypatch, session)
    cfg = GitHubCIConfig(token="t", owner="o", repo="r", max_runs=150)
    out = await list_runs(cfg)
    assert len(out) == 150
    assert len(session.calls) == 2


@pytest.mark.asyncio
async def test_list_runs_default_caps_at_300(monkeypatch):
    session = _MockSession("workflow_runs", total=10_000)
    _patch_session(monkeypatch, session)
    cfg = GitHubCIConfig(token="t", owner="o", repo="r")
    out = await list_runs(cfg)
    assert len(out) == 300
    assert len(session.calls) == 3


@pytest.mark.asyncio
async def test_ls_runs_listing_capped(monkeypatch):
    session = _MockSession("workflow_runs", total=1000)
    _patch_session(monkeypatch, session)
    cfg = GitHubCIConfig(token="t", owner="o", repo="r", max_runs=5)
    accessor = GitHubCIAccessor(config=cfg)
    index = RAMIndexCacheStore()
    runs_path = PathSpec(resource_path=mount_key("/runs", ""),
                         virtual="/runs",
                         directory="/runs")
    ls_cmd = next(c for c in COMMANDS
                  if any(rc.name == "ls" for rc in c._registered_commands))
    out, _ = await ls_cmd.__wrapped__(
        accessor,
        [runs_path],
        args_1=True,
        index=index,
    )
    data = await materialize(out)
    names = [line for line in data.decode().splitlines() if line.strip()]
    assert len(names) == 5
