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
import json
import os
import time
import uuid
from collections.abc import Iterator

import boto3
import jwt as pyjwt
import pytest
from httpx import ASGITransport, AsyncClient, Response
from moto.server import ThreadedMotoServer
from pydantic import BaseModel

from mirage import Workspace
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.server import build_app
from mirage.server.auth.config import AuthConfig, JWTConfig
from mirage.server.env import ENV_HOME
from mirage.server.registry import WorkspaceRegistry
from mirage.server.routers import workspaces as workspaces_router
from mirage.vfs.s3.config import S3Config


class HeldSourceConfig(BaseModel):
    account: str = "default"


async def answer_token(config: HeldSourceConfig, ref: str) -> ResolvedSecret:
    return ResolvedSecret(fields={"credential": f"xoxb-{ref}"})


async def refuse_token(config: HeldSourceConfig, ref: str) -> ResolvedSecret:
    raise SecretsError("source unreachable")


async def slow_token(config: HeldSourceConfig, ref: str) -> ResolvedSecret:
    await asyncio.sleep(0.05)
    return ResolvedSecret(fields={"credential": f"xoxb-{ref}"})


def _slack_body(source: str, workspace_id: str) -> dict:
    return {
        "config": {
            "mounts": {
                "/": {"vfs": "ram", "mode": "WRITE"},
                "/slack": {
                    "vfs": "slack",
                    "mode": "READ",
                    "config": {
                        "token": {
                            "from": "prod",
                            "ref": "bot",
                            "key": "credential",
                        }
                    },
                },
            },
            "secrets": {"prod": {"source": source}},
            "workspace_id": workspace_id,
        }
    }


def _minimal_config() -> dict:
    return {
        "config": {
            "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
        },
    }


async def _shell(ws, line: str) -> tuple[int, str]:
    result = await ws.shell(line)
    return result.exit_code, await result.stdout_str()


def _make_app_with_short_grace(grace: float = 0.2):
    exit_event = asyncio.Event()
    app = build_app(idle_grace_seconds=grace, exit_event=exit_event)
    return app, exit_event


@pytest.mark.asyncio
async def test_create_list_get_delete_round_trip():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        assert r.status_code == 201, r.text
        detail = r.json()
        wid = detail["id"]
        assert uuid.UUID(wid).version == 7
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
async def test_delete_drops_the_workspace_state(tmp_path):
    # Deleting a workspace deletes everything it kept, so one created
    # again under the same id finds no link, no history and no state on
    # disk from the first.
    state = tmp_path / "state"
    app = build_app(
        idle_grace_seconds=10.0,
        exit_event=asyncio.Event(),
        state_root=state,
    )
    body = {**_minimal_config(), "id": "again"}
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        runner = app.state.registry.get("again").runner
        code, _ = await runner.call(
            _shell(runner.ws, "ln -s /data /alias && echo secret-token")
        )
        assert code == 0
        assert (state / "workspaces" / "again").is_dir()
        assert (await client.delete("/v1/workspaces/again")).status_code == 200
        assert not (state / "workspaces" / "again").exists()
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        runner = app.state.registry.get("again").runner
        code, out = await runner.call(
            _shell(
                runner.ws,
                "readlink /alias || echo no-link; cat /.bash_history",
            )
        )
        assert "no-link" in out
        assert "secret-token" not in out
        await client.delete("/v1/workspaces/again")


@pytest.mark.asyncio
async def test_a_dot_id_is_refused_before_it_can_name_the_state_root(
    tmp_path,
):
    # Deleting a workspace removes its state directory whole, and the
    # dot names would make that the root or the workspaces directory.
    app = build_app(
        idle_grace_seconds=10.0,
        exit_event=asyncio.Event(),
        state_root=tmp_path,
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        for wid in ("..", "."):
            body = {**_minimal_config(), "id": wid}
            r = await client.post("/v1/workspaces", json=body)
            assert r.status_code == 400, r.text
            r = await client.post(
                "/v1/workspaces/load", json={"key": "missing.tar", "id": wid}
            )
            assert "invalid workspace id" in r.json()["detail"], r.text


@pytest.mark.asyncio
async def test_a_failed_delete_answers_500_and_releases_the_id(
    tmp_path, monkeypatch
):
    app = build_app(
        idle_grace_seconds=10.0,
        exit_event=asyncio.Event(),
        state_root=tmp_path,
    )
    body = {**_minimal_config(), "id": "doomed"}
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        ws = app.state.registry.get("doomed").runner.ws

        async def refuse(workspace_id):
            raise RuntimeError("store on fire")

        monkeypatch.setattr(ws.state_store, "drop", refuse)
        r = await client.delete("/v1/workspaces/doomed")
        assert r.status_code == 500
        assert "store on fire" in r.json()["detail"]
        assert "doomed" not in app.state.registry


@pytest.mark.asyncio
async def test_create_with_explicit_id():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = {**_minimal_config(), "id": "myws"}
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201
        assert r.json()["id"] == "myws"

        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 200
        assert r.json()["id"] == "myws"

        other = {
            "config": {"mounts": {"/": {"vfs": "ram", "mode": "READ"}}},
            "id": "myws",
        }
        r = await client.post("/v1/workspaces", json=other)
        assert r.status_code == 409


@pytest.mark.asyncio
async def test_create_answers_a_held_config_id_without_building(monkeypatch):
    closed: list[Workspace] = []
    real_close = Workspace.close

    async def spy(self: Workspace) -> None:
        closed.append(self)
        await real_close(self)

    register_secrets("held-src", HeldSourceConfig, answer_token)
    app, _ = _make_app_with_short_grace(grace=10.0)
    body = _slack_body("held-src", "named")
    other = {
        "config": {
            "mounts": {"/": {"vfs": "ram", "mode": "READ"}},
            "workspace_id": "named",
        }
    }
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.post("/v1/workspaces", json=body)
        register_secrets("held-src", HeldSourceConfig, refuse_token)
        monkeypatch.setattr(Workspace, "close", spy)
        again = await client.post("/v1/workspaces", json=body)
        refused = await client.post("/v1/workspaces", json=other)
        await app.state.registry.remove("named")
    assert first.status_code == 201, first.text
    assert again.status_code == 200, again.text
    assert again.json()["id"] == "named"
    assert refused.status_code == 409
    assert closed == []


@pytest.mark.asyncio
async def test_concurrent_creates_of_one_config_build_it_once(monkeypatch):
    closed: list[Workspace] = []
    real_close = Workspace.close

    async def spy(self: Workspace) -> None:
        closed.append(self)
        await real_close(self)

    register_secrets("slow-src", HeldSourceConfig, slow_token)
    app, _ = _make_app_with_short_grace(grace=10.0)
    body = _slack_body("slow-src", "racing")
    monkeypatch.setattr(Workspace, "close", spy)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        answers = await asyncio.gather(
            client.post("/v1/workspaces", json=body),
            client.post("/v1/workspaces", json=body),
        )
    assert sorted(r.status_code for r in answers) == [200, 201]
    assert closed == []
    await app.state.registry.remove("racing")


@pytest.mark.asyncio
async def test_a_create_of_another_config_does_not_wait_behind_a_stuck_one():
    entered = asyncio.Event()
    release = asyncio.Event()

    async def gated_token(
        config: HeldSourceConfig, ref: str
    ) -> ResolvedSecret:
        entered.set()
        await release.wait()
        return ResolvedSecret(fields={"credential": f"xoxb-{ref}"})

    register_secrets("gated-src", HeldSourceConfig, gated_token)
    app, _ = _make_app_with_short_grace(grace=10.0)
    other = {
        "config": {
            "mounts": {"/": {"vfs": "ram", "mode": "READ"}},
            "workspace_id": "stuck",
        }
    }
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = asyncio.create_task(
            client.post(
                "/v1/workspaces", json=_slack_body("gated-src", "stuck")
            )
        )
        await asyncio.wait_for(entered.wait(), timeout=5)
        refused = await asyncio.wait_for(
            client.post("/v1/workspaces", json=other), timeout=5
        )
        release.set()
        built = await first
    assert refused.status_code == 409
    assert built.status_code == 201
    await app.state.registry.remove("stuck")


@pytest.mark.asyncio
async def test_create_refuses_an_id_whose_deletion_is_in_flight():
    app, _ = _make_app_with_short_grace(grace=10.0)
    body = {"config": {**_minimal_config()["config"], "workspace_id": "going"}}
    release = asyncio.Event()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.post("/v1/workspaces", json=body)
        runner = app.state.registry.get("going").runner
        stop = runner.stop

        async def held_stop(*, delete: bool = False) -> None:
            await release.wait()
            await stop(delete=delete)

        runner.stop = held_stop
        removal = asyncio.create_task(app.state.registry.remove("going"))
        await asyncio.sleep(0)
        during = await client.post("/v1/workspaces", json=body)
        release.set()
        await removal
        after = await client.post("/v1/workspaces", json=body)
    assert first.status_code == 201
    assert during.status_code == 409
    assert after.status_code == 201


@pytest.mark.asyncio
async def test_get_verbose_includes_internals():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
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
@pytest.mark.skipif(
    not os.environ.get("REDIS_URL"), reason="REDIS_URL not set"
)
async def test_get_verbose_internals_with_redis_cache():
    body = {
        "config": {
            "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
            "cache": {
                "type": "redis",
                "url": os.environ["REDIS_URL"],
                "key_prefix": "test:summary:",
            },
        },
    }
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
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
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]

        r = await client.post(f"/v1/workspaces/{wid}/clone", json={})
        assert r.status_code == 201, r.text
        clone = r.json()
        assert clone["id"] != wid
        assert uuid.UUID(clone["id"]).version == 7
        assert {m["prefix"] for m in clone["mounts"]} == {"/"}

        r = await client.get("/v1/workspaces")
        assert len(r.json()) == 2


@pytest.mark.asyncio
async def test_clone_with_explicit_id_409_on_collision():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
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
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.get("/v1/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["workspaces"] == 0
        assert body["uptime_s"] >= 0

        await client.post("/v1/workspaces", json=_minimal_config())
        r = await client.get("/v1/health")
        assert r.json()["workspaces"] == 1


async def _download(client: AsyncClient, wid: str) -> bytes:
    r = await client.get(f"/v1/workspaces/{wid}/snapshot")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/x-tar"
    return r.content


async def _upload(
    client: AsyncClient, tar: bytes, request: dict | None = None
) -> Response:
    return await client.post(
        "/v1/workspaces/load",
        files={
            "request": (
                "request.json",
                json.dumps(request or {}),
                "application/json",
            ),
            "snapshot": ("snap.tar", tar, "application/x-tar"),
        },
    )


@pytest.fixture()
def snapshot_store() -> Iterator[S3Config]:
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    host, port = server.get_host_and_port()
    endpoint = f"http://{host}:{port}"
    boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name="us-east-1",
    ).create_bucket(Bucket="snaps")
    yield S3Config(
        bucket="snaps",
        region="us-east-1",
        endpoint_url=endpoint,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        path_style=True,
        key_prefix="team/",
    )
    server.stop()


@pytest.mark.asyncio
async def test_snapshot_answers_the_tar_and_writes_nothing(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    app, _ = _make_app_with_short_grace(grace=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        tar = await _download(client, r.json()["id"])
    assert tar[257:262] == b"ustar"
    assert not (tmp_path / "snapshots").exists()


@pytest.mark.asyncio
async def test_snapshot_upload_round_trip():
    app, _ = _make_app_with_short_grace(grace=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "echo hi > /f"}
        )
        r = await _upload(client, await _download(client, wid))
        assert r.status_code == 201, r.text
        new_id = r.json()["id"]
        assert new_id != wid
        r = await client.post(
            f"/v1/workspaces/{new_id}/shell", json={"command": "cat /f"}
        )
        assert r.json()["stdout"] == "hi\n"


@pytest.mark.asyncio
async def test_snapshot_store_round_trip(snapshot_store):
    app = build_app(idle_grace_seconds=10.0, snapshot_store=snapshot_store)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/snapshot", json={"key": "a.tar"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["key"] == "a.tar" and r.json()["size"] > 0
        r = await client.post(
            "/v1/workspaces/load", json={"key": "a.tar", "id": "back"}
        )
        assert r.status_code == 201, r.text
        r = await client.post("/v1/workspaces/load", json={"key": "nope.tar"})
        assert r.status_code == 400, r.text
        assert r.json()["detail"] == "snapshot not found: nope.tar"
    keys = boto3.client(
        "s3",
        endpoint_url=snapshot_store.endpoint_url,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name="us-east-1",
    ).list_objects_v2(Bucket="snaps")["Contents"]
    assert [k["Key"] for k in keys] == ["team/a.tar"]


@pytest.mark.asyncio
async def test_an_account_keeps_its_snapshots_under_its_own_prefix(
    snapshot_store, tmp_path
):
    secret = "s" * 32
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(
            mode="jwt", jwt=JWTConfig(key=secret, algorithm="HS256")
        ),
        state_root=tmp_path / "state",
        snapshot_store=snapshot_store,
    )

    def client(sub: str) -> AsyncClient:
        token = pyjwt.encode(
            {"sub": sub, "exp": int(time.time()) + 60}, secret, "HS256"
        )
        return AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
            headers={"Authorization": f"Bearer {token}"},
        )

    async with client("alice") as alice, client("bob") as bob:
        r = await alice.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        r = await alice.post(
            f"/v1/workspaces/{wid}/snapshot", json={"key": "s.tar"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["key"] == "s.tar"
        r = await alice.post(
            f"/v1/workspaces/{wid}/snapshot", json={"key": "../x.tar"}
        )
        assert r.status_code == 400, r.text
        r = await bob.post("/v1/workspaces/load", json={"key": "s.tar"})
        assert r.status_code == 400, r.text
        r = await alice.post("/v1/workspaces/load", json={"key": "s.tar"})
        assert r.status_code == 201, r.text
    await app.state.registry.close_all()
    keys = boto3.client(
        "s3",
        endpoint_url=snapshot_store.endpoint_url,
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
        region_name="us-east-1",
    ).list_objects_v2(Bucket="snaps")["Contents"]
    assert [k["Key"] for k in keys if k["Key"].endswith("/s.tar")] == [
        "team/accounts/alice/s.tar"
    ]


@pytest.mark.asyncio
async def test_a_key_needs_a_snapshot_store():
    app, _ = _make_app_with_short_grace(grace=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        for r in (
            await client.post(
                f"/v1/workspaces/{wid}/snapshot", json={"key": "a.tar"}
            ),
            await client.post("/v1/workspaces/load", json={"key": "a.tar"}),
        ):
            assert r.status_code == 400, r.text
            assert r.json()["detail"] == "this server has no snapshot store"


@pytest.mark.asyncio
async def test_load_needs_one_source():
    app, _ = _make_app_with_short_grace(grace=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces/load", json={})
        assert r.status_code == 400, r.text
        r = await _upload(client, b"", {"key": "a.tar"})
        assert r.status_code == 400, r.text
        assert "not both" in r.json()["detail"]
        r = await _upload(client, b"not a tar")
        assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_load_refuses_a_snapshot_over_the_limit(monkeypatch):
    monkeypatch.setattr(workspaces_router, "MAX_SNAPSHOT_PART", 8)
    app, _ = _make_app_with_short_grace(grace=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await _upload(client, b"x" * 9)
    assert r.status_code == 413, r.text
    assert r.json()["detail"] == "snapshot part too large"


@pytest.mark.asyncio
async def test_two_workspaces_run_in_isolation():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid_a = r.json()["id"]
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid_b = r.json()["id"]
        registry = app.state.registry
        runner_a = registry.get(wid_a).runner
        runner_b = registry.get(wid_b).runner

        slow = asyncio.create_task(
            runner_a.call(runner_a.ws.shell("sleep 1.0"))
        )
        await asyncio.sleep(0.05)
        start = time.monotonic()
        result = await runner_b.call(runner_b.ws.shell("echo quick"))
        elapsed = time.monotonic() - start
        assert result.exit_code == 0
        assert elapsed < 0.5, (
            f"workspace B took {elapsed:.2f}s while A was sleeping; "
            "isolation violated"
        )
        await slow


@pytest.mark.asyncio
async def test_idle_shutdown_event_fires_after_grace():
    app, exit_event = _make_app_with_short_grace(grace=0.2)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        await client.delete(f"/v1/workspaces/{wid}")
        await asyncio.wait_for(exit_event.wait(), timeout=2.0)
        assert exit_event.is_set()


@pytest.mark.asyncio
async def test_idle_timer_canceled_when_new_workspace_created():
    app, exit_event = _make_app_with_short_grace(grace=0.5)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
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

    def _fake_add(self, prefix, mountpoint=None, backend=None):
        calls.append((prefix, mountpoint))
        return mountpoint or "/tmp/fake"

    monkeypatch.setattr(
        "mirage.workspace.workspace.Workspace.add_fuse_mount", _fake_add
    )
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = {
            "config": {
                "mounts": {
                    "/data/": {"vfs": "ram", "backend": "fuse"},
                    "/pinned/": {
                        "vfs": "ram",
                        "backend": "fuse",
                        "mountpoint": "/tmp/pinned",
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

    def _boom_add(self, prefix, mountpoint=None, backend=None):
        if not closed:
            orig = self.close

            async def _spy():
                closed.append(True)
                await orig()

            self.close = _spy
        raise ValueError("boom collision")

    monkeypatch.setattr(
        "mirage.workspace.workspace.Workspace.add_fuse_mount", _boom_add
    )
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = {
            "config": {
                "mounts": {
                    "/data/": {"vfs": "ram", "backend": "fuse"},
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
        from mirage.vfs.ram import RAMVFS

        ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
        entry = registry.add(ws)
        await registry.remove(entry.id)
        assert registry.exit_event.is_set()

    asyncio.run(_run())


@pytest.mark.asyncio
async def test_create_defaults_to_disk_store_under_state_root(tmp_path):
    """The daemon default is disk: a workspace created without a store:
    block persists its sessions+meta under the app's state root."""
    exit_event = asyncio.Event()
    app = build_app(
        idle_grace_seconds=10.0, exit_event=exit_event, state_root=tmp_path
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = {**_minimal_config(), "id": "diskws"}
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
        r = await client.post(
            "/v1/workspaces/diskws/shell", json={"command": "echo hi"}
        )
        assert r.status_code == 200
    assert (tmp_path / "workspaces" / "diskws" / "workspace.json").is_file()


@pytest.mark.asyncio
async def test_create_explicit_store_block_wins_over_disk_default(tmp_path):
    exit_event = asyncio.Event()
    app = build_app(
        idle_grace_seconds=10.0, exit_event=exit_event, state_root=tmp_path
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = {
            "config": {
                **_minimal_config()["config"],
                "store": {"type": "ram"},
            },
            "id": "ramws",
        }
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
    assert not (tmp_path / "workspaces" / "ramws").exists()


@pytest.mark.asyncio
async def test_create_with_an_unresolvable_secrets_block_is_a_bad_request():
    """A `secrets:` block naming a source the host cannot resolve is
    the caller's mistake, like a mount whose VFS is unknown."""
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = _minimal_config()
        body["config"]["secrets"] = {"prod": {"source": "nope"}}
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 400, r.text
        assert "nope" in r.json()["detail"]


@pytest.mark.asyncio
async def test_clone_with_a_bad_secrets_override_is_a_bad_request():
    """The clone route was the last one answering 500 where create,
    load and the historical clone all answer 400."""
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        for bad in (
            {"prod": {"source": "nope"}},
            {"prod": {"nosource": 1}},
            [],
        ):
            r = await client.post(
                f"/v1/workspaces/{wid}/clone",
                json={"override": {"secrets": bad}},
            )
            assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_clone_with_a_bad_disk_override_is_a_bad_request(tmp_path):
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        block = {
            "vfs": "disk",
            "config": {"root": str(tmp_path), "folder_versions": "no"},
        }
        r = await client.post(
            f"/v1/workspaces/{wid}/clone",
            json={"override": {"mounts": {"/": block}}},
        )
        assert r.status_code == 400, r.text
        assert r.json()["detail"] == "disk: folder_versions: must be a boolean"


@pytest.mark.asyncio
async def test_clone_with_an_unknown_mount_key_is_a_bad_request():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        block = {"vfs": "ram", "config": {"bogus": 1}}
        r = await client.post(
            f"/v1/workspaces/{wid}/clone",
            json={"override": {"mounts": {"/": block}}},
        )
        assert r.status_code == 400, r.text
        assert "bogus" in r.json()["detail"]


@pytest.mark.asyncio
async def test_create_with_a_bad_disk_mount_is_a_bad_request(tmp_path):
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = _minimal_config()
        body["config"]["mounts"]["/"] = {
            "vfs": "disk",
            "config": {"root": str(tmp_path), "folder_versions": "no"},
        }
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 400, r.text
        assert r.json()["detail"] == "disk: folder_versions: must be a boolean"


@pytest.mark.asyncio
async def test_load_with_a_non_mapping_secrets_override_is_a_bad_request(
    tmp_path,
):
    """Filtering it to None here turned a bad override into a
    successful load whose every restored pointer was unresolvable."""
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        tar = await _download(client, r.json()["id"])
        r = await _upload(client, tar, {"override": {"secrets": []}})
        assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_load_with_an_unbuildable_vfs_override_is_a_bad_request(
    tmp_path,
):
    """A ref the daemon cannot load is the caller's mistake, so it is
    answered like the other bad overrides; it used to escape as a 500."""
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        tar = await _download(client, r.json()["id"])
        r = await _upload(
            client,
            tar,
            {
                "override": {
                    "mounts": {"/": {"vfs": f"{tmp_path}/gone.py:Wiki"}}
                }
            },
        )
        assert r.status_code == 400, r.text
        assert r.json()["detail"].startswith("override build failed: ")
        assert "gone.py" in r.json()["detail"]


@pytest.mark.asyncio
async def test_workspace_cancel_and_kill_reach_every_session(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = (
            await client.post("/v1/workspaces", json=_minimal_config())
        ).json()["id"]
        await client.post(
            f"/v1/workspaces/{wid}/sessions", json={"session_id": "a"}
        )
        await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "sleep 30 &", "session_id": "a"},
        )
        r = await client.post(
            f"/v1/workspaces/{wid}/shell?background=true",
            json={"command": "sleep 30"},
        )
        job_id = r.json()["job_id"]
        for _ in range(500):
            status = (await client.get(f"/v1/jobs/{job_id}")).json()["status"]
            if status == "running":
                break
            await asyncio.sleep(0.01)
        assert (await client.post(f"/v1/workspaces/{wid}/cancel")).json() == {
            "canceled": 1
        }
        assert (await client.post(f"/v1/workspaces/{wid}/kill")).json() == {
            "killed": 1
        }
        await client.delete(f"/v1/workspaces/{wid}")


@pytest.mark.asyncio
async def test_close_keeps_state_for_the_same_id(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        body = {**_minimal_config(), "id": "keep"}
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        await client.post(
            "/v1/workspaces/keep/shell", json={"command": "echo kept"}
        )
        r = await client.post("/v1/workspaces/keep/close")
        assert r.status_code == 200
        assert (await client.get("/v1/workspaces/keep")).status_code == 404
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        r = await client.post(
            "/v1/workspaces/keep/shell", json={"command": "history"}
        )
        assert "echo kept" in r.json()["stdout"]
        await client.delete("/v1/workspaces/keep")
