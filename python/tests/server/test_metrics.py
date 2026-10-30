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

from collections import Counter

import pytest
from httpx import ASGITransport, AsyncClient

from mirage import RAMVFS, MountMode, Workspace
from mirage.server import build_app
from mirage.server.jobs import ExecutionTable
from mirage.server.metrics import CONTENT_TYPE, render_metrics
from mirage.server.registry import WorkspaceRegistry


@pytest.mark.asyncio
async def test_metrics_read_the_registry_and_the_responses():
    registry = WorkspaceRegistry(max_workspaces=4, idle_grace_seconds=10.0)
    registry.add(Workspace({"/": (RAMVFS(), MountMode.WRITE)}), "w")
    text = render_metrics(registry, ExecutionTable(), 1.5, {429: 1, 200: 3})
    own = [
        line
        for line in text.splitlines()
        if not line.startswith(
            ("process_", "# HELP process_", "# TYPE process_")
        )
    ]
    assert own == [
        "# HELP mirage_uptime_seconds Seconds since the server started.",
        "# TYPE mirage_uptime_seconds gauge",
        "mirage_uptime_seconds 1.5",
        "# HELP mirage_workspaces Workspaces the server holds.",
        "# TYPE mirage_workspaces gauge",
        "mirage_workspaces 1",
        "# HELP mirage_max_workspaces The most workspaces the server holds at once.",
        "# TYPE mirage_max_workspaces gauge",
        "mirage_max_workspaces 4",
        "# HELP mirage_sessions Sessions across the server's workspaces.",
        "# TYPE mirage_sessions gauge",
        "mirage_sessions 1",
        "# HELP mirage_jobs_running Lines the server's API is running.",
        "# TYPE mirage_jobs_running gauge",
        "mirage_jobs_running 0",
        "# HELP mirage_draining 1 while the server drains for shutdown, else 0.",
        "# TYPE mirage_draining gauge",
        "mirage_draining 0",
        "# HELP mirage_http_responses_total Responses the server sent, by status code.",
        "# TYPE mirage_http_responses_total counter",
        'mirage_http_responses_total{code="200"} 3',
        'mirage_http_responses_total{code="429"} 1',
    ]
    assert text.endswith("\n")
    await registry.close_all()


@pytest.mark.asyncio
async def test_the_app_counts_every_response_it_sends():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/v1/workspaces/nope")).status_code == 404
        r = await client.get("/v1/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"] == CONTENT_TYPE
    assert 'mirage_http_responses_total{code="404"} 1' in r.text
    assert app.state.responses == Counter({404: 1, 200: 1})
