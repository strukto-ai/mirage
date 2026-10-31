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

import weakref

import pytest
from httpx import ASGITransport, AsyncClient
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from mirage import RAMVFS, MountMode, Workspace
from mirage.server import RateLimit, build_app
from mirage.server import metrics as metrics_module
from mirage.server.metrics import _create, register_metrics
from mirage.server.registry import WorkspaceRegistry


class Refusals:
    def __init__(self) -> None:
        self.reasons: list[str] = []

    def add(self, amount: int, attributes: dict[str, str]) -> None:
        self.reasons += [attributes["reason"]] * amount


def _read(reader: InMemoryMetricReader) -> dict[str, list[tuple[dict, float]]]:
    data = reader.get_metrics_data()
    assert data is not None
    return {
        metric.name: [
            (dict(point.attributes or {}), point.value)
            for point in metric.data.data_points
        ]
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
    }


@pytest.mark.asyncio
async def test_the_instruments_read_the_registered_registries(monkeypatch):
    monkeypatch.setattr(metrics_module, "_registries", weakref.WeakSet())
    reader = InMemoryMetricReader()
    refusals = _create(MeterProvider(metric_readers=[reader]).get_meter("t"))
    registry = WorkspaceRegistry(max_workspaces=4, idle_grace_seconds=10.0)
    registry.add(Workspace({"/": (RAMVFS(), MountMode.WRITE)}), "w")
    register_metrics(registry)
    refusals.add(1, {"reason": "rate_limit"})
    got = _read(reader)
    assert got["mirage.workspace.count"] == [({}, 1)]
    assert got["mirage.workspace.limit"] == [({}, 4)]
    assert got["mirage.session.count"] == [({}, 1)]
    assert got["mirage.job.running"] == [({}, 0)]
    assert got["mirage.server.shutting_down"] == [({}, 0)]
    assert got["mirage.request.refused"] == [({"reason": "rate_limit"}, 1)]
    await registry.drain(0)
    assert _read(reader)["mirage.server.shutting_down"] == [({}, 1)]
    await registry.close_all()


@pytest.mark.asyncio
async def test_the_server_counts_what_it_refuses(monkeypatch):
    refusals = Refusals()
    monkeypatch.setattr(metrics_module, "_instruments", lambda: refusals)
    app = build_app(
        idle_grace_seconds=10.0,
        max_sessions=1,
        max_workspaces=1,
        rate_limits=[RateLimit("header:x-tenant", "1/minute")],
    )
    config = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "write"}}}}
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        busy = {"x-tenant": "a"}
        await client.get("/v1/workspaces", headers=busy)
        assert (
            await client.get("/v1/workspaces", headers=busy)
        ).status_code == 429
        r = await client.post("/v1/workspaces", json={**config, "id": "w"})
        assert r.status_code == 201
        assert (
            await client.post("/v1/workspaces", json=config)
        ).status_code == 503
        r = await client.post(
            "/v1/workspaces/w/sessions", json={"session_id": "s"}
        )
        assert r.status_code == 429
        app.state.registry.draining = True
        assert (
            await client.post("/v1/workspaces", json=config)
        ).status_code == 503
    assert refusals.reasons == [
        "rate_limit",
        "max_workspaces",
        "max_sessions",
        "shutting_down",
    ]
    await app.state.registry.close_all()
