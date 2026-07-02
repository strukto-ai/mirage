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

import asyncio
import os
import time

import pytest
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app
from mirage.server.registry import WorkspaceRegistry


def _minimal_config() -> dict:
    return {
        "config": {
            "mounts": {
                "/": {
                    "resource": "ram",
                    "mode": "WRITE"
                }
            },
        },
    }


def _make_app_with_short_grace(grace: float = 0.2, snapshot_root=None):
    exit_event = asyncio.Event()
    app = build_app(idle_grace_seconds=grace,
                    exit_event=exit_event,
                    snapshot_root=snapshot_root)
    return app, exit_event


@pytest.mark.asyncio
async def test_create_list_get_delete_round_trip():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        assert r.status_code == 201, r.text
        detail = r.json()
        wid = detail["id"]
        assert wid.startswith("ws_")
        assert detail["mode"] == "write"
        assert any(m["prefix"] == "/" for m in detail["mounts"])

        r = await client.get("/v1/workspaces")
        assert r.status_code == 200
        briefs = r.json()
        assert len(briefs) == 1
        assert briefs[0]["id"] == wid
        assert briefs[0]["mount_count"] == 1

        r = await client.get(f"/v1/workspaces/{wid}")
        assert r.status_code == 200
        assert r.json()["id"] == wid

        r = await client.delete(f"/v1/workspaces/{wid}")
        assert r.status_code == 200
        assert r.json()["id"] == wid

        r = await client.get(f"/v1/workspaces/{wid}")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_with_explicit_id():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        body = {**_minimal_config(), "id": "myws"}
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201
        assert r.json()["id"] == "myws"

        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 409


@pytest.mark.asyncio
async def test_get_verbose_includes_internals():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]

        r = await client.get(f"/v1/workspaces/{wid}")
        assert r.json()["internals"] is None

        r = await client.get(f"/v1/workspaces/{wid}?verbose=true")
        internals = r.json()["internals"]
        assert internals is not None
        assert "cache_bytes" in internals
        assert "cache_entries" in internals


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get("REDIS_URL"),
                    reason="REDIS_URL not set")
async def test_get_verbose_internals_with_redis_cache():
    body = {
        "config": {
            "mounts": {
                "/": {
                    "resource": "ram",
                    "mode": "WRITE"
                }
            },
            "cache": {
                "type": "redis",
                "url": os.environ["REDIS_URL"],
                "key_prefix": "test:summary:",
            },
        },
    }
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
        wid = r.json()["id"]

        r = await client.get(f"/v1/workspaces/{wid}?verbose=true")
        assert r.status_code == 200, r.text
        internals = r.json()["internals"]
        assert internals is not None
        # Redis cache does not track size or entries; the summary must
        # report them as untracked instead of reaching into RAM-store
        # internals or conflating "not tracked" with an empty cache.
        assert internals["cache_bytes"] is None
        assert internals["cache_entries"] is None

        await client.delete(f"/v1/workspaces/{wid}")


@pytest.mark.asyncio
async def test_clone_returns_new_workspace_with_same_mounts():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]

        r = await client.post(f"/v1/workspaces/{wid}/clone", json={})
        assert r.status_code == 201, r.text
        clone = r.json()
        assert clone["id"] != wid
        assert clone["id"].startswith("ws_")
        assert {m["prefix"] for m in clone["mounts"]} == {"/"}

        r = await client.get("/v1/workspaces")
        assert len(r.json()) == 2


@pytest.mark.asyncio
async def test_clone_with_explicit_id_409_on_collision():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        body = {**_minimal_config(), "id": "src"}
        await client.post("/v1/workspaces", json=body)

        body2 = {**_minimal_config(), "id": "other"}
        await client.post("/v1/workspaces", json=body2)

        r = await client.post("/v1/workspaces/src/clone", json={"id": "other"})
        assert r.status_code == 409


@pytest.mark.asyncio
async def test_health_endpoint():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.get("/v1/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["workspaces"] == 0
        assert body["uptime_s"] >= 0

        await client.post("/v1/workspaces", json=_minimal_config())
        r = await client.get("/v1/health")
        assert r.json()["workspaces"] == 1


@pytest.mark.asyncio
async def test_snapshot_writes_tar_to_path(tmp_path):
    app, _ = _make_app_with_short_grace(grace=10.0, snapshot_root=tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        target = tmp_path / "snap.tar"
        r = await client.post(f"/v1/workspaces/{wid}/snapshot",
                              json={"path": str(target)})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["path"] == str(target)
        assert body["size"] > 0
        assert target.exists()
        assert target.stat().st_size == body["size"]


@pytest.mark.asyncio
async def test_snapshot_load_round_trip(tmp_path):
    app, _ = _make_app_with_short_grace(grace=10.0, snapshot_root=tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        target = tmp_path / "snap.tar"
        await client.post(f"/v1/workspaces/{wid}/snapshot",
                          json={"path": str(target)})

        r = await client.post("/v1/workspaces/load",
                              json={"path": str(target)})
        assert r.status_code == 201, r.text
        new_id = r.json()["id"]
        assert new_id != wid

        r = await client.get(f"/v1/workspaces/{new_id}")
        assert r.status_code == 200
        assert {m["prefix"] for m in r.json()["mounts"]} == {"/"}


@pytest.mark.asyncio
async def test_snapshot_rejects_path_outside_root(tmp_path):
    app, _ = _make_app_with_short_grace(grace=10.0, snapshot_root=tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        r = await client.post(f"/v1/workspaces/{wid}/snapshot",
                              json={"path": "../escape.tar"})
        assert r.status_code == 400, r.text
        assert not (tmp_path.parent / "escape.tar").exists()


@pytest.mark.asyncio
async def test_load_missing_path_returns_400(tmp_path):
    app, _ = _make_app_with_short_grace(grace=10.0, snapshot_root=tmp_path)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces/load",
                              json={"path": str(tmp_path / "nope.tar")})
        assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_two_workspaces_run_in_isolation():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid_a = r.json()["id"]
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid_b = r.json()["id"]
        registry = app.state.registry
        runner_a = registry.get(wid_a).runner
        runner_b = registry.get(wid_b).runner

        slow = asyncio.create_task(
            runner_a.call(runner_a.ws.execute("sleep 1.0")))
        await asyncio.sleep(0.05)
        start = time.monotonic()
        result = await runner_b.call(runner_b.ws.execute("echo quick"))
        elapsed = time.monotonic() - start
        assert result.exit_code == 0
        assert elapsed < 0.5, (
            f"workspace B took {elapsed:.2f}s while A was sleeping; "
            "isolation violated")
        await slow


@pytest.mark.asyncio
async def test_idle_shutdown_event_fires_after_grace():
    app, exit_event = _make_app_with_short_grace(grace=0.2)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        await client.delete(f"/v1/workspaces/{wid}")
        await asyncio.wait_for(exit_event.wait(), timeout=2.0)
        assert exit_event.is_set()


@pytest.mark.asyncio
async def test_idle_timer_canceled_when_new_workspace_created():
    app, exit_event = _make_app_with_short_grace(grace=0.5)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        await client.delete(f"/v1/workspaces/{wid}")
        await asyncio.sleep(0.1)
        assert not exit_event.is_set()
        await client.post("/v1/workspaces", json=_minimal_config())
        await asyncio.sleep(0.6)
        assert not exit_event.is_set()


@pytest.mark.asyncio
async def test_create_workspace_bridges_fuse_through_manager(monkeypatch):
    calls = []

    def _fake_add(self, prefix, mountpoint=None):
        calls.append((prefix, mountpoint))
        return mountpoint or "/tmp/fake"

    monkeypatch.setattr("mirage.workspace.workspace.Workspace.add_fuse_mount",
                        _fake_add)
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        body = {
            "config": {
                "mounts": {
                    "/data/": {
                        "resource": "ram",
                        "fuse": True
                    },
                    "/pinned/": {
                        "resource": "ram",
                        "fuse": "/tmp/pinned"
                    },
                },
            },
        }
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
    assert ("/data/", None) in calls
    assert any(mp == "/tmp/pinned" for _, mp in calls)


@pytest.mark.asyncio
async def test_create_workspace_rolls_back_on_fuse_failure(monkeypatch):
    closed = []

    def _boom_add(self, prefix, mountpoint=None):
        if not closed:
            orig = self.close

            async def _spy():
                closed.append(True)
                await orig()

            self.close = _spy
        raise ValueError("boom collision")

    monkeypatch.setattr("mirage.workspace.workspace.Workspace.add_fuse_mount",
                        _boom_add)
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://test") as client:
        body = {
            "config": {
                "mounts": {
                    "/data/": {
                        "resource": "ram",
                        "fuse": True
                    },
                },
            },
        }
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 409, r.text

        r = await client.get("/v1/workspaces")
        assert r.json() == []
    assert closed == [True]


def test_registry_zero_grace_fires_immediately():

    async def _run():
        registry = WorkspaceRegistry(idle_grace_seconds=0)
        from mirage import MountMode, Workspace
        from mirage.resource.ram import RAMResource
        ws = Workspace({"/": (RAMResource(), MountMode.WRITE)})
        entry = registry.add(ws)
        await registry.remove(entry.id)
        assert registry.exit_event.is_set()

    asyncio.run(_run())
