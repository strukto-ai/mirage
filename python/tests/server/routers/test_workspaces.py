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
import bz2
import gzip
import io
import json
import lzma
import os
import shutil
import tarfile
import threading
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from urllib.parse import quote

import boto3
import jwt as pyjwt
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, Response
from moto.server import ThreadedMotoServer
from pydantic import BaseModel

from mirage import MountMode, Workspace
from mirage.execution.line.types import LineState
from mirage.policy.base import Policy
from mirage.policy.types import (
    CommandContext,
    Deny,
    WorkspaceContext,
)
from mirage.resources.memory import memory_resource_store
from mirage.resources.types import EntryInput
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.server import build_app
from mirage.server.auth.config import AuthConfig, JWTConfig
from mirage.server.env import ENV_HOME
from mirage.server.registry import WorkspaceRegistry
from mirage.server.routers import workspaces as workspaces_router
from mirage.types import JsonValue
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3.config import S3Config
from mirage.workspace.snapshot.tar_io import write_tar
from mirage.workspace.snapshot.utils import BLOB_REF_KEY
from mirage.workspace.store import DiskWorkspaceStateStore
from tests.fixtures.mcp_server import TOKEN, served_mcp


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
@pytest.mark.parametrize(
    "mounts,extra,invalid_time",
    [
        (False, False, None),
        (True, True, None),
        (False, True, None),
        (True, False, 123),
        (False, True, 123),
        (True, False, "tomorrow"),
        (False, True, "tomorrow"),
    ],
)
async def test_create_validates_config(mounts, extra, invalid_time):
    app, _ = _make_app_with_short_grace(grace=10.0)
    config = {
        **({"mounts": {}} if mounts else {}),
        **({"system_time": invalid_time} if invalid_time is not None else {}),
        **({"unknown_setting": True} if extra else {}),
    }
    if not mounts:
        error = {
            "code": "missing_field",
            "message": "config.mounts is required",
            "param": "config.mounts",
        }
    elif isinstance(invalid_time, int):
        error = {
            "code": "invalid_value",
            "message": "config.system_time must be a string",
            "param": "config.system_time",
        }
    elif invalid_time is not None:
        error = {
            "code": "invalid_value",
            "message": "system_time is not an ISO 8601 instant with an "
            "offset from 1970 through 2261, as 2026-03-02T09:00:00Z",
            "param": "config.system_time",
        }
    else:
        error = {
            "code": "unknown_field",
            "message": "config.unknown_setting is not a known field",
            "param": "config.unknown_setting",
        }
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces", json={"id": "bad", "config": config}
        )
        assert (r.status_code, r.json()) == (400, {"error": error})
        assert "bad" not in app.state.registry


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
        assert "mode" not in detail and "fuse_mountpoints" not in detail
        assert any(m["prefix"] == "/" for m in detail["mounts"])

        r = await client.get("/v1/workspaces")
        assert r.status_code == 200
        briefs = r.json()
        assert len(briefs) == 1
        assert briefs[0].keys() == {"id", "status", "created_at"}
        assert briefs[0]["id"] == wid

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
            assert r.json()["error"]["param"] == "id", r.text


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
        assert r.json()["error"] == {
            "code": "internal",
            "message": "internal server error",
        }
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
async def test_a_server_at_max_workspaces_answers_503():
    app = build_app(idle_grace_seconds=10.0, max_workspaces=2)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        made = []
        for wid in ("a", "b"):
            r = await client.post(
                "/v1/workspaces", json={**_minimal_config(), "id": wid}
            )
            assert r.status_code == 201, r.text
            made.append(wid)
        r = await client.post("/v1/workspaces", json=_minimal_config())
        assert r.status_code == 503
        assert (
            r.json()["error"]["message"] == "server is at max_workspaces (2)"
        )
        r = await client.post(f"/v1/workspaces/{made[0]}/clone", json={})
        assert r.status_code == 503
        r = await client.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "a"}
        )
        assert r.status_code == 200
        r = await client.delete(f"/v1/workspaces/{made[0]}")
        assert r.status_code == 200
        r = await client.post("/v1/workspaces", json=_minimal_config())
        assert r.status_code == 201, r.text


class NoDisk(Policy):
    async def pre_workspace(self, ctx: WorkspaceContext) -> Deny | None:
        mounts = ctx.config.get("mounts") or {}
        assert isinstance(mounts, dict)
        if any(
            isinstance(block, dict) and block.get("vfs") == "disk"
            for block in mounts.values()
        ):
            account = ctx.caller.account if ctx.caller else None
            return Deny(f"no disk mounts for {account}")
        return None

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        return Deny("no rm here") if ctx.command == "rm" else None


def _disk_config(root: str) -> dict:
    return {
        "config": {
            "mounts": {
                "/": {"vfs": "ram", "mode": "WRITE"},
                "/host": {"vfs": "disk", "config": {"root": root}},
            }
        }
    }


@pytest.mark.asyncio
async def test_the_server_policies_refuse_a_workspace_before_it_is_built(
    tmp_path,
):
    app = build_app(idle_grace_seconds=10.0, policies=[NoDisk()])
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces", json=_disk_config(str(tmp_path))
        )
        assert r.status_code == 403
        assert r.json()["error"]["message"] == "no disk mounts for None"
        assert len(app.state.registry) == 0
        r = await client.post(
            "/v1/workspaces?explain=true", json=_disk_config(str(tmp_path))
        )
        assert r.status_code == 200
        said = r.json()
        assert [said["outcome"], said["reason"]] == [
            "deny",
            "no disk mounts for None",
        ]
        assert said["answers"] == [
            {
                "kind": "deny",
                "reason": "no disk mounts for None",
                "policy": "NoDisk",
            }
        ]
        r = await client.post(
            "/v1/workspaces?explain=true", json=_minimal_config()
        )
        assert [r.json()["outcome"], r.json()["answers"]] == ["allow", []]
        assert len(app.state.registry) == 0
        r = await client.post("/v1/workspaces", json=_minimal_config())
        assert r.status_code == 201, r.text
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "touch /a; rm /a"},
        )
        assert r.json()["exit_code"] == 126
        override = {
            "mounts": {"/host": {"vfs": "disk", "config": {"root": "/"}}}
        }
        r = await client.post(
            f"/v1/workspaces/{wid}/clone", json={"override": override}
        )
        assert r.status_code == 403
        r = await client.post(
            "/v1/workspaces/load",
            json={"key": "snap.tar", "override": override},
        )
        assert r.status_code == 403


_NO_RUNTIMES = """
def pre_workspace(ctx):
    if "runtimes" in ctx["config"]:
        return {"kind": "deny", "reason": "runtimes are the server's"}
"""

_NO_CAT = """
def pre_command(ctx):
    if ctx["command"] == "cat":
        return {"kind": "deny", "reason": "no cat"}
"""


@pytest.mark.asyncio
async def test_a_policy_file_answers_like_the_server_policies(tmp_path):
    (tmp_path / "no_runtimes.py").write_text(_NO_RUNTIMES)
    (tmp_path / "no_cat.py").write_text(_NO_CAT)
    policy_file = tmp_path / "policy.yaml"
    policy_file.write_text(
        "pre_workspace:\n  - script: no_runtimes.py\n"
        "pre_command:\n  - script: no_cat.py\n"
    )
    app = build_app(idle_grace_seconds=10.0, policy_file=policy_file)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        refused = _minimal_config()
        refused["config"]["runtimes"] = ["monty"]
        r = await client.post("/v1/workspaces", json=refused)
        assert r.status_code == 403
        assert r.json()["error"]["message"] == "runtimes are the server's"
        r = await client.post("/v1/workspaces", json=_minimal_config())
        assert r.status_code == 201, r.text
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo hi > /a; cat /a"},
        )
        assert r.json()["exit_code"] == 126
        r = await client.delete(f"/v1/workspaces/{wid}")
        assert r.status_code == 200


def test_a_policy_file_names_only_methods(tmp_path):
    policy_file = tmp_path / "policy.yaml"
    policy_file.write_text("pre_build: []\n")
    with pytest.raises(ValueError, match="names pre_build"):
        build_app(idle_grace_seconds=10.0, policy_file=policy_file)


async def _answer(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    await reader.read(1024)
    writer.write(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n"
        b"Connection: close\r\n\r\nok\n"
    )
    await writer.drain()
    writer.close()


@pytest_asyncio.fixture
async def listening() -> AsyncIterator[int]:
    server = await asyncio.start_server(_answer, "127.0.0.1", 0)
    yield server.sockets[0].getsockname()[1]
    server.close()
    await server.wait_closed()


async def _curl_from(app: FastAPI, port: int, network: bool) -> int:
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        body = _minimal_config()
        body["config"]["network"] = network
        r = await client.post("/v1/workspaces", json=body)
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": f"curl -sS http://127.0.0.1:{port}/"},
        )
        await client.delete(f"/v1/workspaces/{wid}")
        return int(r.json()["exit_code"])


@pytest.mark.asyncio
async def test_a_posted_network_holds_its_workspace(listening):
    app = build_app(idle_grace_seconds=10.0)
    assert await _curl_from(app, listening, True) == 0
    assert await _curl_from(app, listening, False) == 7


@pytest.mark.asyncio
async def test_a_posted_config_keeps_its_variables_as_written():
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        body = _minimal_config()
        body["config"]["env"] = {"GREETING": "${HOME}"}
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": 'echo "$GREETING"'},
        )
        assert r.json()["stdout"] == "${HOME}\n"


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
    # The secret is read on the loop the workspace will run on, a thread of
    # its own, so it is held with thread-safe events.
    entered = threading.Event()
    release = threading.Event()

    async def gated_token(
        config: HeldSourceConfig, ref: str
    ) -> ResolvedSecret:
        entered.set()
        await asyncio.to_thread(release.wait)
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
        assert await asyncio.to_thread(entered.wait, 5)
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
async def test_get_answers_404_while_the_workspace_is_deleted():
    app, _ = _make_app_with_short_grace(grace=10.0)
    body = {"config": {**_minimal_config()["config"], "workspace_id": "going"}}
    release = asyncio.Event()

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        await client.post("/v1/workspaces", json=body)
        runner = app.state.registry.get("going").runner
        stop = runner.stop

        async def held_stop(*, delete: bool = False) -> None:
            await stop(delete=delete)
            await release.wait()

        runner.stop = held_stop
        removal = asyncio.create_task(app.state.registry.remove("going"))
        await asyncio.sleep(0)
        during = await client.get("/v1/workspaces/going")
        release.set()
        await removal
    assert during.status_code == 404


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
        assert r.json()["error"] == {
            "code": "invalid_value",
            "message": "key names no snapshot",
            "param": "key",
        }
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


def _jwt_app(secret: str, state_root, **kwargs):
    return build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(
            mode="jwt", jwt=JWTConfig(key=secret, algorithm="HS256")
        ),
        state_root=state_root,
        **kwargs,
    )


def _account(app, secret: str, sub: str) -> AsyncClient:
    token = pyjwt.encode(
        {"sub": sub, "exp": int(time.time()) + 60}, secret, "HS256"
    )
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    )


@pytest.mark.asyncio
async def test_a_leading_slash_names_the_same_key(snapshot_store):
    app = build_app(idle_grace_seconds=10.0, snapshot_store=snapshot_store)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/snapshot", json={"key": "/lead.tar"}
        )
        assert r.status_code == 200, r.text
        r = await client.post("/v1/workspaces/load", json={"key": "lead.tar"})
        assert r.status_code == 201, r.text
    await app.state.registry.close_all()


@pytest.mark.asyncio
async def test_a_failed_create_leaves_the_id_free(tmp_path):
    secret = "s" * 32
    app = _jwt_app(secret, tmp_path / "state")
    bad = {**_minimal_config(), "id": "w"}
    bad["config"] = {**bad["config"], "secrets": {"prod": {"source": "nope"}}}
    async with (
        _account(app, secret, "alice") as alice,
        _account(app, secret, "bob") as bob,
    ):
        r = await alice.post("/v1/workspaces", json=bad)
        assert r.status_code == 400, r.text
        r = await bob.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 201, r.text
    await app.state.registry.close_all()


@pytest.mark.asyncio
async def test_a_failed_create_keeps_its_claim_with_what_it_saved(
    tmp_path, monkeypatch
):
    secret = "s" * 32
    app = _jwt_app(secret, tmp_path / "state", max_sessions=4)
    registry = app.state.registry
    add = registry.add
    calls = 0

    def refuse_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ValueError("refused")
        return add(*args, **kwargs)

    monkeypatch.setattr(registry, "add", refuse_once)
    async with (
        _account(app, secret, "alice") as alice,
        _account(app, secret, "bob") as bob,
    ):
        r = await alice.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 409, r.text
        r = await bob.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 409, r.text
        r = await alice.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 201, r.text
    await registry.close_all()


@pytest.mark.asyncio
async def test_state_from_before_accounts_is_no_accounts_to_take(tmp_path):
    state = tmp_path / "state"
    local = build_app(idle_grace_seconds=10.0, state_root=state)
    async with AsyncClient(
        transport=ASGITransport(app=local), base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 201, r.text
        r = await client.post(
            "/v1/workspaces/w/shell", json={"command": "echo kept"}
        )
        assert r.status_code == 200, r.text
    await local.state.registry.close_all()
    secret = "s" * 32
    app = _jwt_app(secret, state)
    async with _account(app, secret, "alice") as alice:
        r = await alice.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 409, r.text
        r = await alice.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "fresh"}
        )
        assert r.status_code == 201, r.text
    await app.state.registry.close_all()


@pytest.mark.asyncio
async def test_a_create_waits_out_a_load_of_the_same_id(
    snapshot_store, tmp_path, monkeypatch
):
    # A create that took over a load's claim could register first, and the
    # load's failure would then drop the owner record of a live workspace.
    # A slow release still frees the id before the load answers.
    secret = "s" * 32
    app = _jwt_app(secret, tmp_path / "state", snapshot_store=snapshot_store)
    # The load runs on the loop its workspace would run on, a thread of its
    # own, so it is held with thread-safe events.
    loading = threading.Event()
    finish = threading.Event()
    release = WorkspaceRegistry.release

    async def held_load(*args, **kwargs):
        loading.set()
        await asyncio.to_thread(finish.wait)
        raise ValueError("not a snapshot")

    async def slow_release(self, workspace_id):
        await asyncio.sleep(0.05)
        await release(self, workspace_id)

    monkeypatch.setattr(Workspace, "load", held_load)
    monkeypatch.setattr(WorkspaceRegistry, "release", slow_release)
    async with _account(app, secret, "alice") as alice:
        load = asyncio.create_task(
            alice.post("/v1/workspaces/load", json={"key": "s.tar", "id": "w"})
        )
        await asyncio.to_thread(loading.wait)
        r = await alice.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 409, r.text
        finish.set()
        assert (await load).status_code == 400
        r = await alice.post(
            "/v1/workspaces", json={**_minimal_config(), "id": "w"}
        )
        assert r.status_code == 201, r.text
    await app.state.registry.close_all()


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
            assert (
                r.json()["error"]["message"]
                == "this server has no snapshot store"
            )


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
        assert "not both" in r.json()["error"]["message"]
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
    assert r.json()["error"]["message"] == "snapshot part too large"


@pytest.mark.asyncio
@pytest.mark.parametrize("compress", [None, "gz", "bz2", "xz"])
async def test_load_caps_expanded_snapshot_and_releases_id(
    monkeypatch, compress
):
    monkeypatch.setattr(
        workspaces_router, "MAX_SNAPSHOT_BYTES", 32_768, raising=False
    )
    app, _ = _make_app_with_short_grace(grace=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        source = await client.post("/v1/workspaces", json=_minimal_config())
        original = await _download(client, source.json()["id"])
        with tarfile.open(fileobj=io.BytesIO(original)) as tar:
            manifest = json.load(tar.extractfile("manifest.json"))
        manifest["padding"] = "x" * 128_000
        buffer = io.BytesIO()
        write_tar(buffer, manifest, {})
        if compress is not None:
            buffer = io.BytesIO(
                {
                    "gz": gzip.compress,
                    "bz2": bz2.compress,
                    "xz": lzma.compress,
                }[compress](buffer.getvalue())
            )
        r = await _upload(client, buffer.getvalue(), {"id": "limited"})
        assert r.status_code == 400, r.text
        assert (
            "snapshot exceeds expanded size limit"
            in r.json()["error"]["message"]
        )
        assert "limited" not in app.state.registry
        r = await _upload(client, original, {"id": "limited"})
        assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_load_refuses_repeated_blob_allocations_and_releases_id(
    monkeypatch,
):
    monkeypatch.setattr(workspaces_router, "MAX_SNAPSHOT_BYTES", 32_768)
    app, _ = _make_app_with_short_grace(grace=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        source = await client.post("/v1/workspaces", json=_minimal_config())
        original = await _download(client, source.json()["id"])
        with tarfile.open(fileobj=io.BytesIO(original)) as tar:
            manifest = json.load(tar.extractfile("manifest.json"))
        ram = next(
            m["vfs_state"] for m in manifest["mounts"] if m["prefix"] == "/"
        )
        ram["files"] = {f"/f{i}": {BLOB_REF_KEY: "b/f"} for i in range(16)}
        buffer = io.BytesIO()
        write_tar(buffer, manifest, {"b/f": b"x" * 16_384})
        buffer = io.BytesIO(bz2.compress(buffer.getvalue()))
        r = await _upload(client, buffer.getvalue(), {"id": "repeated"})
        assert r.status_code == 400, r.text
        assert (
            "snapshot exceeds expanded size limit"
            in r.json()["error"]["message"]
        )
        assert "repeated" not in app.state.registry
        r = await _upload(client, original, {"id": "repeated"})
        assert r.status_code == 201, r.text


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
        assert "nope" in r.json()["error"]["message"]


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
async def test_clone_with_two_overrides_on_one_disk_root_is_a_bad_request(
    tmp_path,
):
    src = Workspace({"/a": RAMVFS(), "/b": RAMVFS()}, mode=MountMode.WRITE)
    tar = io.BytesIO()
    try:
        await src.snapshot(tar)
    finally:
        await src.close()
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await _upload(client, tar.getvalue(), {"id": "src-disk"})
        assert r.status_code == 201, r.text
        block = {"vfs": "disk", "config": {"root": str(tmp_path)}}
        r = await client.post(
            "/v1/workspaces/src-disk/clone",
            json={"override": {"mounts": {"/a": block, "/b": block}}},
        )
        assert r.status_code == 400, r.text
        assert "is already mounted at" in r.json()["error"]["message"]


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
        assert (
            r.json()["error"]["message"]
            == "disk: folder_versions: must be a boolean"
        )


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
        assert "bogus" in r.json()["error"]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "write, status",
    [("conditional", 400), ("bogus", 400), (True, 400), (None, 201)],
)
async def test_clone_judges_an_override_write_policy(write, status):
    # A refused write policy is the caller's mistake; null leaves the saved one.
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        block = {"vfs": "ram", "write": write}
        r = await client.post(
            f"/v1/workspaces/{wid}/clone",
            json={"override": {"mounts": {"/": block}}},
        )
        assert r.status_code == status, r.text


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
        assert (
            r.json()["error"]["message"]
            == "disk: folder_versions: must be a boolean"
        )


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
        assert r.json()["error"]["code"] == "invalid_request"


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
            params={"session_id": "a"},
            json={"command": "sleep 30 &"},
        )
        running = asyncio.create_task(
            client.post(
                f"/v1/workspaces/{wid}/shell", json={"command": "sleep 30"}
            )
        )
        for _ in range(500):
            if any(
                request.line.record.command == "sleep 30"
                and request.line.record.state == LineState.RUNNING
                for request in app.state.jobs.requests()
            ):
                break
            await asyncio.sleep(0.01)
        assert (await client.post(f"/v1/workspaces/{wid}/cancel")).json() == {
            "canceled": 1
        }
        assert (await client.post(f"/v1/workspaces/{wid}/kill")).json() == {
            "killed": 1
        }
        await client.delete(f"/v1/workspaces/{wid}")
        await asyncio.gather(running, return_exceptions=True)


def _disk_body(root) -> dict:
    return {
        "id": "keep",
        "config": {
            "mounts": {
                "/": {
                    "vfs": "disk",
                    "mode": "WRITE",
                    "config": {"root": str(root)},
                }
            }
        },
    }


@pytest.mark.asyncio
async def test_a_stopped_workspace_starts_with_its_files_and_cwd(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_disk_body(data))
        assert r.status_code == 201, r.text
        r = await client.post(
            "/v1/workspaces/keep/sessions", json={"session_id": "s"}
        )
        assert r.status_code == 201, r.text
        r = await client.post(
            "/v1/workspaces/keep/shell?session_id=s",
            json={"command": "mkdir /d && echo kept > /d/f.txt && cd /d"},
        )
        assert r.json()["exit_code"] == 0, r.text
        r = await client.post("/v1/workspaces/keep/stop")
        assert r.status_code == 200, r.text
        r = await client.get("/v1/workspaces/keep")
        assert r.json()["status"] == "stopped"
        r = await client.post(
            "/v1/workspaces/keep/shell", json={"command": "pwd"}
        )
        assert (r.status_code, r.json()) == (
            409,
            {
                "error": {
                    "code": "workspace_stopped",
                    "message": "workspace 'keep' is stopped; start it first",
                }
            },
        )
        r = await client.post(
            "/v1/workspaces/never/shell", json={"command": "pwd"}
        )
        assert (r.status_code, r.json()["error"]["code"]) == (404, "not_found")
        r = await client.post("/v1/workspaces/keep/start")
        assert r.status_code == 200, r.text
        assert (r.json()["id"], r.json()["status"]) == ("keep", "running")
        r = await client.post(
            "/v1/workspaces/keep/shell?session_id=s",
            json={"command": "pwd && cat f.txt"},
        )
        assert r.json()["stdout"] == "/d\nkept\n"
        await client.delete("/v1/workspaces/keep")


@pytest.mark.asyncio
async def test_a_second_stop_answers_as_the_first(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        body = {**_minimal_config(), "id": "keep"}
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        for _ in range(2):
            r = await client.post("/v1/workspaces/keep/stop")
            assert r.status_code == 200, r.text
            assert r.json()["id"] == "keep"
        listed = (await client.get("/v1/workspaces")).json()
        assert [(w["id"], w["status"]) for w in listed] == [
            ("keep", "stopped")
        ]
        # State kept with no config, as a workspace created before configs
        # were saved: it stops again, and cannot be started.
        (tmp_path / "state" / "configs" / "keep.json").unlink()
        r = await client.post("/v1/workspaces/keep/stop")
        assert r.status_code == 200, r.text
        r = await client.post("/v1/workspaces/keep/start")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_a_second_start_answers_the_running_workspace(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        body = {**_minimal_config(), "id": "keep"}
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        await client.post("/v1/workspaces/keep/stop")
        first = await client.post("/v1/workspaces/keep/start")
        second = await client.post("/v1/workspaces/keep/start")
        assert (first.status_code, second.status_code) == (200, 200)
        assert first.json()["created_at"] == second.json()["created_at"]
        assert len(app.state.registry) == 1
        await client.delete("/v1/workspaces/keep")


@pytest.mark.asyncio
async def test_a_clone_under_a_stopped_id_drops_its_config(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        for wid in ("w", "src"):
            body = {**_minimal_config(), "id": wid}
            r = await client.post("/v1/workspaces", json=body)
            assert r.status_code == 201, r.text
        await client.post("/v1/workspaces/w/stop")
        r = await client.post("/v1/workspaces/src/clone", json={"id": "w"})
        assert r.status_code == 201, r.text
        await client.post("/v1/workspaces/w/stop")
        assert (await client.post("/v1/workspaces/w/start")).status_code == 404


@pytest.mark.asyncio
async def test_a_stopped_workspace_is_listed_shown_and_deleted(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        for wid in ("off", "on"):
            body = {**_minimal_config(), "id": wid}
            r = await client.post("/v1/workspaces", json=body)
            assert r.status_code == 201, r.text
        await client.post("/v1/workspaces/off/stop")
        listed = (await client.get("/v1/workspaces")).json()
        assert [(w["id"], w["status"]) for w in listed] == [
            ("on", "running"),
            ("off", "stopped"),
        ]
        assert listed[1]["created_at"] > 0
        got = (await client.get("/v1/workspaces/off")).json()
        assert got["status"] == "stopped"
        assert got["sessions"] == [] and got["internals"] is None
        assert [(m["prefix"], m["vfs"], m["mode"]) for m in got["mounts"]] == [
            ("/", "ram", "write")
        ]
        r = await client.delete("/v1/workspaces/off")
        assert (r.status_code, r.json()["id"]) == (200, "off")
        assert (await client.get("/v1/workspaces/off")).status_code == 404
        r = await client.post("/v1/workspaces/off/start")
        assert r.status_code == 404
        listed = (await client.get("/v1/workspaces")).json()
        assert [w["id"] for w in listed] == ["on"]
        await client.delete("/v1/workspaces/on")


@pytest.mark.asyncio
async def test_a_stopped_workspace_is_deleted_from_the_store_its_config_names(
    tmp_path,
):
    own = tmp_path / "own"
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        body = {
            "id": "mine",
            "config": {
                "mounts": {"/": {"vfs": "ram"}},
                "store": {"type": "disk", "root": str(own)},
            },
        }
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
        await client.post("/v1/workspaces/mine/stop")
        got = (await client.get("/v1/workspaces/mine")).json()
        assert got["status"] == "stopped"
        assert got["created_at"] > 0
        assert (own / "workspaces" / "mine").exists()
        r = await client.delete("/v1/workspaces/mine")
        assert r.status_code == 200, r.text
        assert not (own / "workspaces" / "mine").exists()


@pytest.mark.asyncio
async def test_an_id_with_state_but_no_saved_config_answers_404(tmp_path):
    # A rejected create can leave state but never saves a config.
    store = DiskWorkspaceStateStore(str(tmp_path / "state"))
    await store.replace_meta("orphan", {})
    await store.close()
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/v1/workspaces/orphan")).status_code == 404
        assert (await client.get("/v1/workspaces")).json() == []
        assert (
            await client.delete("/v1/workspaces/orphan")
        ).status_code == 404


@pytest.mark.asyncio
async def test_a_stopped_workspace_whose_store_cannot_be_read_is_listed(
    tmp_path,
):
    own = tmp_path / "own"
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        body = {
            "id": "mine",
            "config": {
                "mounts": {"/": {"vfs": "ram"}},
                "store": {"type": "disk", "root": str(own)},
            },
        }
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
        ram = {"mounts": {"/": {"vfs": "ram"}}}
        r = await client.post(
            "/v1/workspaces", json={"id": "on", "config": ram}
        )
        assert r.status_code == 201, r.text
        await client.post("/v1/workspaces/mine/stop")
        shutil.rmtree(own)
        own.write_text("not a directory")
        listed = await client.get("/v1/workspaces")
        assert listed.status_code == 200, listed.text
        rows = [
            (
                w["id"],
                w["status"],
                w["created_at"] if w["id"] == "mine" else None,
            )
            for w in listed.json()
        ]
        assert rows == [("on", "running", None), ("mine", "stopped", 0)]


@pytest.mark.asyncio
async def test_a_stopped_workspace_shows_the_mounts_it_ran_with(
    tmp_path,
):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        config = {
            "mode": "rw",
            "mounts": {
                "/": {"vfs": "ram", "mode": "r"},
                "/data": {"vfs": "ram"},
            },
        }
        body = {"id": "w", "config": config}
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201

        async def view() -> list[tuple[str, str, str]]:
            d = (await client.get("/v1/workspaces/w")).json()
            return [(m["prefix"], m["vfs"], m["mode"]) for m in d["mounts"]]

        running = await view()
        assert running == [("/data/", "ram", "write"), ("/", "ram", "read")]
        await client.post("/v1/workspaces/w/stop")
        assert await view() == running


@pytest.mark.asyncio
async def test_start_of_an_unknown_id_is_not_found(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces/nope/start")
        assert r.status_code == 404
        assert r.json()["error"]["message"] == "workspace not found"
        r = await client.post("/v1/workspaces/nope/stop")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_set_profile_defines_and_replaces_a_name(tmp_path):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = (
            await client.post("/v1/workspaces", json=_minimal_config())
        ).json()["id"]
        route = f"/v1/workspaces/{wid}/profiles/reader"
        r = await client.put(route, json={"commands": {"allow": ["whoami"]}})
        assert r.status_code == 200 and r.json() == {"name": "reader"}
        await client.post(
            f"/v1/workspaces/{wid}/sessions",
            json={"session_id": "a", "profile": "reader"},
        )
        line = {"command": "whoami; echo hi"}
        shell = f"/v1/workspaces/{wid}/shell"
        r = await client.post(shell, params={"session_id": "a"}, json=line)
        assert r.json()["stdout"] == "reader\n"
        await client.put(
            route, json={"commands": {"allow": ["whoami", "echo"]}}
        )
        r = await client.patch(
            f"/v1/workspaces/{wid}/sessions/a", json={"profile": "reader"}
        )
        assert r.status_code == 200
        r = await client.post(shell, params={"session_id": "a"}, json=line)
        assert r.json()["stdout"] == "reader\nhi\n"
        refused = {
            "commands": {
                "allow": ["ls"],
                "deny": [{"commands": ["cat *"], "reason": "sealed"}],
            }
        }
        r = await client.put(route, json=refused)
        assert r.status_code == 400
        r = await client.put(f"{route}x", json={"bogus": 1})
        assert r.status_code == 400
        (tmp_path / "guard.py").mkdir()
        script = {"script": str(tmp_path / "guard.py")}
        unreadable = {"policy": {"pre_command": [script]}}
        r = await client.put(f"{route}y", json=unreadable)
        assert (
            r.status_code == 400
            and "directory" in r.json()["error"]["message"]
        )
        r = await client.put("/v1/workspaces/nope/profiles/reader", json={})
        assert r.status_code == 404
        await client.delete(f"/v1/workspaces/{wid}")


@pytest.mark.asyncio
async def test_clone_with_a_bad_capacity_override_is_a_bad_request():
    app, _ = _make_app_with_short_grace(grace=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/clone",
            json={
                "override": {
                    "mounts": {
                        "/": {"vfs": "ram", "config": {"capacity": "1.5MB"}}
                    }
                }
            },
        )
        assert r.status_code == 400, r.text
        assert (
            "capacity must be a size like 100MB"
            in r.json()["error"]["message"]
        )


@pytest.mark.asyncio
async def test_a_server_shutting_down_refuses_new_workspaces():
    app, _ = _make_app_with_short_grace(grace=10.0)
    app.state.registry.draining = True
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=_minimal_config())
    assert r.status_code == 503
    assert r.json()["error"]["message"] == "server is shutting down"


@pytest.mark.asyncio
async def test_logs_page_and_export():
    app, _ = _make_app_with_short_grace(grace=10.0)
    content = app.openapi()["paths"]["/v1/workspaces/{workspace_id}/logs"][
        "get"
    ]["responses"]["200"]["content"]
    assert "application/json" in content
    assert "application/x-ndjson" in content
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = (
            await client.post("/v1/workspaces", json=_minimal_config())
        ).json()["id"]
        url = f"/v1/workspaces/{wid}/logs"
        assert (await client.get(url)).json() == {"items": [], "next": None}
        assert (await client.get(url, params={"format": "jsonl"})).text == ""
        for line in ("echo hi > /a.txt", "cat /a.txt"):
            assert (
                await client.post(
                    f"/v1/workspaces/{wid}/shell", json={"command": line}
                )
            ).status_code == 200
        page = (await client.get(url)).json()
        assert len(page["items"]) == 2
        assert page["next"] is None
        assert {item["command"] for item in page["items"]} == {
            "echo hi > /a.txt",
            "cat /a.txt",
        }
        assert [item["started_at"] for item in page["items"]] == sorted(
            [item["started_at"] for item in page["items"]], reverse=True
        )
        for item in page["items"]:
            assert set(item) == {
                "id",
                "command",
                "cwd",
                "started_at",
                "duration_ms",
                "exit_code",
                "stdout",
                "stderr",
                "user_id",
                "api_key_id",
                "mounts",
            }
            assert item["exit_code"] == 0
            assert item["user_id"] is None and item["api_key_id"] is None
            assert 1_000_000_000_000 < item["started_at"] < 10_000_000_000_000
            assert len(item["mounts"]) == 1
        first = (await client.get(url, params={"limit": 1})).json()
        second = (
            await client.get(url, params={"limit": 1, "after": first["next"]})
        ).json()
        assert first["items"] + second["items"] == page["items"]
        assert second["next"] is None
        exported = await client.get(
            url, params={"format": "jsonl", "limit": "bad", "after": "bad"}
        )
        assert exported.status_code == 200
        assert exported.headers["content-type"].startswith(
            "application/x-ndjson"
        )
        assert exported.text.endswith("\n")
        lines = [json.loads(line) for line in exported.text.splitlines()]
        commands = [line for line in lines if line["type"] == "command"]
        assert [line["id"] for line in commands] == [
            item["id"] for item in reversed(page["items"])
        ]
        assert commands[0]["timestamp"] == page["items"][-1]["started_at"]
        assert (
            await client.get(url, params={"session": commands[0]["session"]})
        ).json() == page
        assert (
            await client.get(url, params={"session": "missing"})
        ).json() == {"items": [], "next": None}
        for params in (
            {"session": "bad\nsession"},
            {"limit": "0"},
            {"limit": "201"},
            {"after": "bad"},
        ):
            assert (await client.get(url, params=params)).status_code == 400
        assert (
            await client.get(f"/v1/workspaces/{wid}/history")
        ).status_code == 404
        assert (
            await client.get("/v1/workspaces/nope/logs")
        ).status_code == 404
    await app.state.registry.close_all()


@pytest.mark.asyncio
async def test_a_load_past_max_sessions_is_refused(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(workspaces_router, "refused", seen.append)
    free, _ = _make_app_with_short_grace(grace=10.0)
    capped = build_app(idle_grace_seconds=10.0, max_sessions=2)
    async with AsyncClient(
        transport=ASGITransport(app=free), base_url="http://test"
    ) as client:
        wid = (
            await client.post("/v1/workspaces", json=_minimal_config())
        ).json()["id"]
        for sid in ("a", "b"):
            r = await client.post(
                f"/v1/workspaces/{wid}/sessions", json={"session_id": sid}
            )
            assert r.status_code == 201, r.text
        tar = await _download(client, wid)
    async with AsyncClient(
        transport=ASGITransport(app=capped), base_url="http://test"
    ) as client:
        r = await _upload(client, tar)
    assert r.status_code == 400
    assert r.json()["error"]["message"] == (
        "the snapshot holds 3 sessions, past max_sessions (2)"
    )
    assert seen == ["max_sessions"]
    assert len(capped.state.registry) == 0
    await free.state.registry.close_all()


@pytest.mark.asyncio
async def test_a_reopen_past_max_sessions_is_refused(monkeypatch, tmp_path):
    seen: list[str] = []
    monkeypatch.setattr(workspaces_router, "refused", seen.append)
    state = tmp_path / "state"
    free = build_app(idle_grace_seconds=10.0, state_root=state)
    capped = build_app(
        idle_grace_seconds=10.0, state_root=state, max_sessions=2
    )
    body = {**_minimal_config(), "id": "keep"}
    async with AsyncClient(
        transport=ASGITransport(app=free), base_url="http://test"
    ) as client:
        assert (
            await client.post("/v1/workspaces", json=body)
        ).status_code == 201
        for sid in ("a", "b"):
            r = await client.post(
                "/v1/workspaces/keep/sessions", json={"session_id": sid}
            )
            assert r.status_code == 201, r.text
        assert (
            await client.post("/v1/workspaces/keep/stop")
        ).status_code == 200
    async with AsyncClient(
        transport=ASGITransport(app=capped), base_url="http://test"
    ) as client:
        r = await client.post("/v1/workspaces", json=body)
    assert r.status_code == 400
    assert r.json()["error"]["message"] == (
        "the saved workspace holds 3 sessions, past max_sessions (2)"
    )
    assert seen == ["max_sessions"]
    assert len(capped.state.registry) == 0


@pytest.mark.asyncio
async def test_a_cancelled_create_stops_its_runner(monkeypatch):
    before = _runner_threads()
    app, _ = _make_app_with_short_grace(grace=10.0)
    monkeypatch.setattr(app.state.registry, "add", _cancelled)
    with pytest.raises(asyncio.CancelledError):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/v1/workspaces", json=_minimal_config())
    assert _runner_threads() == before


def _runner_threads() -> set[threading.Thread]:
    return {
        t for t in threading.enumerate() if t.name.startswith("mirage-ws-")
    }


def _cancelled(*args, **kwargs):
    raise asyncio.CancelledError()


def _mcp_entry(url: str, token: JsonValue = TOKEN) -> dict[str, JsonValue]:
    return {
        "cli": "mcp",
        "config": {"url": url, "auth": {"type": "bearer", "token": token}},
    }


async def _run(client: AsyncClient, wid: str, line: str) -> dict:
    r = await client.post(
        f"/v1/workspaces/{wid}/shell", json={"command": line}
    )
    return r.json()


class NoMCP(Policy):
    async def pre_workspace(self, ctx: WorkspaceContext) -> Deny | None:
        clis = ctx.config.get("clis") or {}
        assert isinstance(clis, dict)
        if any(
            isinstance(entry, dict) and entry.get("cli") == "mcp"
            for entry in clis.values()
        ):
            return Deny("no MCP servers")
        return None


@pytest.mark.asyncio
async def test_a_create_a_policy_refuses_never_reaches_the_server(tmp_path):
    app = build_app(
        idle_grace_seconds=10.0,
        state_root=tmp_path / "state",
        policies=[NoMCP()],
    )
    async with (
        served_mcp() as fake,
        AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        body = _minimal_config()
        body["config"]["clis"] = {"fx": _mcp_entry(fake.url)}
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 403
        assert fake.requests == []


def _saved(key: str) -> dict[str, str]:
    return {"from": "strukto", "ref": "items", "key": key}


@pytest.mark.asyncio
async def test_a_saved_mcp_cli_installs_through_a_create(tmp_path):
    store = memory_resource_store()
    app = build_app(
        idle_grace_seconds=10.0,
        state_root=tmp_path / "state",
        resource_store=store,
    )
    async with (
        served_mcp() as fake,
        AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        await store.create_entry(
            "cli",
            EntryInput(
                name="items",
                type="mcp",
                fields={"url": fake.url, "auth.type": "bearer"},
                sealed={"auth.token": TOKEN},
            ),
        )
        body = _minimal_config()
        body["config"]["clis"] = {
            "fx": {
                "cli": "mcp",
                "config": {
                    "url": _saved("url"),
                    "auth": {
                        "type": _saved("auth.type"),
                        "token": _saved("auth.token"),
                    },
                },
            }
        }
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 201, r.text
        listed = await _run(client, r.json()["id"], "fx list-items")
        assert listed["stdout"] == "apple\nbanana\n"
    await app.state.registry.close_all()


@pytest.mark.asyncio
async def test_a_create_outside_its_network_never_reaches_the_server(
    tmp_path,
):
    app = build_app(idle_grace_seconds=10.0, state_root=tmp_path / "state")
    async with (
        served_mcp() as fake,
        AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client,
    ):
        body = _minimal_config()
        body["config"]["network"] = False
        body["config"]["clis"] = {"fx": _mcp_entry(fake.url)}
        r = await client.post("/v1/workspaces", json=body)
        assert r.status_code == 400
        assert "cannot list the server's tools" in r.json()["error"]["message"]
        assert fake.requests == []


@pytest.mark.asyncio
async def test_logs_support_existing_session_ids_and_unicode_workspaces():
    app, _ = _make_app_with_short_grace(grace=10.0)
    wid = "工作"
    url = f"/v1/workspaces/{quote(wid, safe='')}"
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (
            await client.post(
                "/v1/workspaces", json={**_minimal_config(), "id": wid}
            )
        ).status_code == 201
        empty = await client.get(f"{url}/logs", params={"format": "jsonl"})
        assert empty.status_code == 200 and empty.content == b""
        assert (
            "filename*=UTF-8''%E5%B7%A5%E4%BD%9C-logs.jsonl"
            in empty.headers["content-disposition"]
        )
        for sid in ("user:42", "s" * 65, "会话"):
            created = await client.post(
                f"{url}/sessions", json={"session_id": sid}
            )
            assert created.status_code == 201, created.text
            result = await client.post(
                f"{url}/shell",
                params={"session_id": sid},
                json={"command": "echo hi"},
            )
            assert result.status_code == 200, result.text
            page = await client.get(f"{url}/logs", params={"session": sid})
            assert page.status_code == 200, page.text
            assert len(page.json()["items"]) == 1
            exported = await client.get(
                f"{url}/logs", params={"session": sid, "format": "jsonl"}
            )
            assert exported.status_code == 200
            assert [
                json.loads(line)["session"]
                for line in exported.text.splitlines()
            ] == [sid, sid]
    await app.state.registry.close_all()


@pytest.mark.asyncio
async def test_large_log_reads_do_not_block_health_requests(monkeypatch):
    app, _ = _make_app_with_short_grace(grace=10.0)
    entered = threading.Event()
    release = threading.Event()
    original = workspaces_router.completed_logs

    def paused(records):
        entered.set()
        release.wait(5)
        return original(records)

    monkeypatch.setattr(workspaces_router, "completed_logs", paused)
    watchdog = threading.Timer(5, release.set)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        wid = (
            await client.post("/v1/workspaces", json=_minimal_config())
        ).json()["id"]
        watchdog.start()
        pending = asyncio.create_task(client.get(f"/v1/workspaces/{wid}/logs"))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            health = await asyncio.wait_for(client.get("/v1/health"), 1)
            assert health.status_code == 200
            assert not release.is_set()
        finally:
            release.set()
            watchdog.cancel()
            await pending
            await asyncio.to_thread(watchdog.join)
    await app.state.registry.close_all()
