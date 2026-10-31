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
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app
from mirage.server.auth.config import AuthConfig, JWTConfig
from mirage.server.mcp.http import DaemonToolOperations
from mirage.server.routers import shell as shell_router
from mirage.server.rpc.server import MirageRpcServer
from mirage.server.stdin import UploadStdin


@dataclass
class KeyPair:
    private_pem: bytes
    public_pem: bytes


@pytest.fixture(scope="module")
def rsa_keys() -> KeyPair:
    private_key = rsa.generate_private_key(
        public_exponent=65537, key_size=2048
    )
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return KeyPair(private_pem=private_pem, public_pem=public_pem)


def _client(app, headers=None):
    transport = ASGITransport(app=app)
    return AsyncClient(
        transport=transport, base_url="http://test", headers=headers or {}
    )


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_accepts_correct_bearer():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="local", local_token="correct-token"),
    )
    async with _client(app, {"Authorization": "Bearer correct-token"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_rejects_wrong_bearer():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="local", local_token="correct-token"),
    )
    async with _client(app, {"Authorization": "Bearer wrong-token"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_rejects_missing_header():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="local", local_token="correct-token"),
    )
    async with _client(app) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_no_token_lets_everything_through():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="local", local_token=None),
    )
    async with _client(app) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_token_mode_accepts_correct_token():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="token", bearer_token="operator-pat"),
    )
    async with _client(app, {"Authorization": "Bearer operator-pat"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_token_mode_rejects_wrong_token():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="token", bearer_token="operator-pat"),
    )
    async with _client(app, {"Authorization": "Bearer something-else"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_token_mode_rejects_jwt_shaped_value():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="token", bearer_token="operator-pat"),
    )
    fake_jwt = "aaaa.bbbb.cccc"
    async with _client(app, {"Authorization": f"Bearer {fake_jwt}"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_accepts_valid_signed(rsa_keys):
    jwt_cfg = JWTConfig(key=rsa_keys.public_pem.decode(), algorithm="RS256")
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg),
    )
    token = pyjwt.encode(
        {"sub": "agent", "exp": int(time.time()) + 60},
        rsa_keys.private_pem,
        algorithm="RS256",
    )
    async with _client(app, {"Authorization": f"Bearer {token}"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.fixture
def key_set(rsa_keys) -> Iterator[str]:
    """Serve the issuer's public key as a JWKS, as Clerk publishes one."""
    public = serialization.load_pem_public_key(rsa_keys.public_pem)
    jwk = pyjwt.algorithms.RSAAlgorithm.to_jwk(public, as_dict=True)
    body = json.dumps({"keys": [{**jwk, "kid": "k1", "use": "sig"}]}).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/jwks.json"
    finally:
        server.shutdown()


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_checks_a_token_against_the_published_key_set(
    rsa_keys, key_set
):
    jwt_cfg = JWTConfig(algorithm="RS256", jwks_url=key_set)
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg),
    )
    claims = {"sub": "agent", "exp": int(time.time()) + 60}
    signed = pyjwt.encode(
        claims, rsa_keys.private_pem, algorithm="RS256", headers={"kid": "k1"}
    )
    unknown = pyjwt.encode(
        claims, rsa_keys.private_pem, algorithm="RS256", headers={"kid": "k9"}
    )
    async with _client(app, {"Authorization": f"Bearer {signed}"}) as c:
        assert (await c.get("/v1/workspaces")).status_code == 200
    async with _client(app, {"Authorization": f"Bearer {unknown}"}) as c:
        assert (await c.get("/v1/workspaces")).status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_refuses_a_token_when_the_key_set_is_not_json(
    rsa_keys,
):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"<html>not a key set</html>")

        def log_message(self, *args) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/jwks.json"
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(
            mode="jwt", jwt=JWTConfig(algorithm="RS256", jwks_url=url)
        ),
    )
    signed = pyjwt.encode(
        {"sub": "agent", "exp": int(time.time()) + 60},
        rsa_keys.private_pem,
        algorithm="RS256",
        headers={"kid": "k1"},
    )
    try:
        async with _client(app, {"Authorization": f"Bearer {signed}"}) as c:
            assert (await c.get("/v1/workspaces")).status_code == 401
    finally:
        server.shutdown()


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_rejects_opaque_bearer(rsa_keys):
    jwt_cfg = JWTConfig(key=rsa_keys.public_pem.decode(), algorithm="RS256")
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg),
    )
    async with _client(app, {"Authorization": "Bearer not-a-jwt"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_rejects_expired(rsa_keys):
    jwt_cfg = JWTConfig(
        key=rsa_keys.public_pem.decode(),
        algorithm="RS256",
        clock_skew_seconds=0,
    )
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg),
    )
    token = pyjwt.encode(
        {"sub": "agent", "exp": int(time.time()) - 60},
        rsa_keys.private_pem,
        algorithm="RS256",
    )
    async with _client(app, {"Authorization": f"Bearer {token}"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_health_endpoint_always_open():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="local", local_token="some-token"),
    )
    async with _client(app) as c:
        r = await c.get("/v1/health")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_authorization_header_without_bearer_prefix_rejected():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="local", local_token="correct-token"),
    )
    async with _client(app, {"Authorization": "correct-token"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


def _jwt_app(rsa_keys, tmp_path):
    jwt_cfg = JWTConfig(key=rsa_keys.public_pem.decode(), algorithm="RS256")
    return build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg),
        state_root=tmp_path / "state",
    )


def _bearer(rsa_keys, claims: dict) -> dict[str, str]:
    token = pyjwt.encode(
        {"exp": int(time.time()) + 60, **claims},
        rsa_keys.private_pem,
        algorithm="RS256",
    )
    return {"Authorization": f"Bearer {token}"}


_RAM = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_rejects_a_token_without_sub(rsa_keys, tmp_path):
    app = _jwt_app(rsa_keys, tmp_path)
    async with _client(app, _bearer(rsa_keys, {})) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_an_account_reaches_only_its_own_workspaces(rsa_keys, tmp_path):
    app = _jwt_app(rsa_keys, tmp_path)
    alice = _client(app, _bearer(rsa_keys, {"sub": "alice"}))
    bob = _client(app, _bearer(rsa_keys, {"sub": "bob"}))
    async with alice, bob:
        r = await alice.post("/v1/workspaces", json={**_RAM, "id": "a"})
        assert r.status_code == 201, r.text
        r = await alice.post(
            "/v1/workspaces/a/shell",
            json={"command": "echo hi"},
        )
        assert r.status_code == 200, r.text
        assert [w["id"] for w in (await alice.get("/v1/workspaces")).json()]
        assert (await bob.get("/v1/workspaces")).json() == []
        for method, path, body in [
            ("GET", "/v1/workspaces/a", None),
            ("DELETE", "/v1/workspaces/a", None),
            ("POST", "/v1/workspaces/a/shell", {"command": "echo x"}),
            ("POST", "/v1/workspaces/a/read", {"path": "/x"}),
            ("POST", "/v1/workspaces/a/rpc", {}),
            ("POST", "/v1/workspaces/a/mcp", {}),
            ("POST", "/v1/workspaces/a/sessions", {}),
            ("GET", "/v1/workspaces/a/sessions", None),
            ("POST", "/v1/workspaces/a/clone", {}),
            ("POST", "/v1/workspaces/a/close", None),
            ("POST", "/v1/workspaces/a/cancel", None),
            ("POST", "/v1/workspaces/a/kill", None),
            ("PUT", "/v1/workspaces/a/profiles/x", {}),
            ("GET", "/v1/workspaces/a/snapshot", None),
        ]:
            r = await bob.request(method, path, json=body)
            assert r.status_code == 404, (method, path, r.status_code)
        # The id is taken, whoever asks; bob learns no more than that.
        r = await bob.post("/v1/workspaces", json={**_RAM, "id": "a"})
        assert r.status_code == 409
        assert (await alice.get("/v1/workspaces/a")).status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
@pytest.mark.parametrize("next_owner", ["bob", "alice"])
async def test_reused_workspace_name_drops_the_deleted_jobs(
    rsa_keys, tmp_path, next_owner
):
    app = _jwt_app(rsa_keys, tmp_path)
    alice = _client(app, _bearer(rsa_keys, {"sub": "alice"}))
    successor = _client(app, _bearer(rsa_keys, {"sub": next_owner}))
    try:
        async with alice, successor:
            r = await alice.post("/v1/workspaces", json={**_RAM, "id": "w"})
            assert r.status_code == 201, r.text
            r = await alice.post(
                "/v1/workspaces/w/shell", json={"command": "echo ALICE-SECRET"}
            )
            assert r.status_code == 200, r.text
            entry = app.state.registry.get("w")
            tools = DaemonToolOperations(
                entry, app.state.jobs, entry.runner.ws.default_session_id
            )
            answer = await tools.shell("echo MCP-SECRET")
            assert answer.text == "MCP-SECRET\n"
            assert len(app.state.jobs.list("w")) == 2
            assert (await alice.delete("/v1/workspaces/w")).status_code == 200
            r = await successor.post(
                "/v1/workspaces", json={**_RAM, "id": "w"}
            )
            assert r.status_code == 201, r.text
            r = await successor.post(
                "/v1/workspaces/w/shell", json={"command": "echo fresh"}
            )
            assert r.status_code == 200, r.text
            commands = [job.command for job in app.state.jobs.list("w")]
            assert commands == ["echo fresh"]
    finally:
        await app.state.jobs.close()
        await app.state.registry.close_all()


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_unfinished_upload_cannot_submit_after_deletion(
    rsa_keys, tmp_path, monkeypatch
):
    app = _jwt_app(rsa_keys, tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    pending = None
    try:
        async with (
            _client(app, _bearer(rsa_keys, {"sub": "alice"})) as alice,
            _client(app, _bearer(rsa_keys, {"sub": "bob"})) as bob,
        ):
            assert (
                await alice.post("/v1/workspaces", json={**_RAM, "id": "w"})
            ).status_code == 201
            require_entry = shell_router.require_entry
            discard = UploadStdin.discard
            discarded = False

            async def observed_discard(stdin):
                nonlocal discarded
                await discard(stdin)
                discarded = True

            monkeypatch.setattr(UploadStdin, "discard", observed_discard)

            def observed_entry(request, workspace_id):
                entry = require_entry(request, workspace_id)
                entered.set()
                return entry

            monkeypatch.setattr(shell_router, "require_entry", observed_entry)

            async def body():
                await release.wait()
                yield (
                    b"--boundary\r\n"
                    b'Content-Disposition: form-data; name="request"\r\n\r\n'
                    b'{"command":"echo ALICE-LATE-SECRET"}\r\n--boundary\r\n'
                    b'Content-Disposition: form-data; name="stdin"\r\n\r\n'
                )
                yield b"x" * (2 * 1024 * 1024)
                yield (
                    b"\r\n--boundary\r\n"
                    b'Content-Disposition: form-data; name="ignored"\r\n\r\nextra'
                )
                yield b"\r\n--boundary--\r\n"

            pending = asyncio.create_task(
                alice.post(
                    "/v1/workspaces/w/shell",
                    content=body(),
                    headers={
                        "Content-Type": "multipart/form-data; boundary=boundary"
                    },
                )
            )
            await asyncio.wait_for(entered.wait(), 5)
            assert (await alice.delete("/v1/workspaces/w")).status_code == 200
            assert (
                await bob.post("/v1/workspaces", json={**_RAM, "id": "w"})
            ).status_code == 201
            release.set()
            r = await pending
            assert r.status_code == 404, r.text
            assert discarded
            assert app.state.jobs.list("w") == []
    finally:
        release.set()
        if pending is not None and not pending.done():
            await pending
        await app.state.jobs.close()
        await app.state.registry.close_all()


@pytest.mark.no_auth_override
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "protocol", ["mcp", "rpc", "rpc_lookup", "rpc_before_lookup"]
)
async def test_retained_adapter_cannot_submit_after_deletion(
    rsa_keys, tmp_path, monkeypatch, protocol
):
    app = _jwt_app(rsa_keys, tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    pending = None
    try:
        async with (
            _client(app, _bearer(rsa_keys, {"sub": "alice"})) as alice,
            _client(app, _bearer(rsa_keys, {"sub": "bob"})) as bob,
        ):
            assert (
                await alice.post("/v1/workspaces", json={**_RAM, "id": "w"})
            ).status_code == 201
            tools = await app.state.mcp.tools("w", None, "alice")
            if protocol in ("rpc_lookup", "rpc_before_lookup"):
                lookup = app.state.mcp.tools

                async def held_lookup(*args):
                    if protocol == "rpc_before_lookup":
                        entered.set()
                        await release.wait()
                    operations = await lookup(*args)
                    if protocol == "rpc_lookup":
                        entered.set()
                        await release.wait()
                    return operations

                monkeypatch.setattr(app.state.mcp, "tools", held_lookup)
            elif protocol == "rpc":
                handle = MirageRpcServer.handle

                async def held_handle(server, message):
                    entered.set()
                    await release.wait()
                    return await handle(server, message)

                monkeypatch.setattr(MirageRpcServer, "handle", held_handle)
            if protocol != "mcp":
                message = {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "shell",
                    "params": {"command": "echo ALICE-LATE-SECRET"},
                }
                payload = (
                    [message, {**message, "id": 2, "method": "tools/shell"}]
                    if protocol == "rpc_before_lookup"
                    else message
                )
                pending = asyncio.create_task(
                    alice.post(
                        "/v1/workspaces/w/rpc",
                        json=payload,
                    )
                )
                await asyncio.wait_for(entered.wait(), 5)
            assert (await alice.delete("/v1/workspaces/w")).status_code == 200
            assert (
                await (alice if protocol == "rpc_before_lookup" else bob).post(
                    "/v1/workspaces", json={**_RAM, "id": "w"}
                )
            ).status_code == 201
            if protocol == "mcp":
                answer = await tools.shell("echo ALICE-LATE-SECRET")
                assert answer.is_error
            else:
                release.set()
                r = await pending
                if protocol in ("rpc_lookup", "rpc_before_lookup"):
                    assert r.status_code == 404, r.text
                    assert r.json() == {"detail": "workspace not found"}
                else:
                    assert "error" in r.json(), r.text
            assert app.state.jobs.list("w") == []
    finally:
        release.set()
        if pending is not None and not pending.done():
            await pending
        await app.state.jobs.close()
        await app.state.registry.close_all()


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_a_stored_workspace_reopens_only_for_its_owner(
    rsa_keys, tmp_path
):
    first = _jwt_app(rsa_keys, tmp_path)
    async with _client(first, _bearer(rsa_keys, {"sub": "alice"})) as alice:
        r = await alice.post("/v1/workspaces", json={**_RAM, "id": "a"})
        assert r.status_code == 201, r.text
    await first.state.registry.close_all()
    # A restarted daemon over the same state root.
    second = _jwt_app(rsa_keys, tmp_path)
    async with _client(second, _bearer(rsa_keys, {"sub": "bob"})) as bob:
        r = await bob.post("/v1/workspaces", json={**_RAM, "id": "a"})
        assert r.status_code == 409
    async with _client(second, _bearer(rsa_keys, {"sub": "alice"})) as alice:
        r = await alice.post("/v1/workspaces", json={**_RAM, "id": "a"})
        assert r.status_code == 201, r.text
    await second.state.registry.close_all()


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_an_account_cannot_shut_the_daemon_down(rsa_keys, tmp_path):
    app = _jwt_app(rsa_keys, tmp_path)
    async with _client(app, _bearer(rsa_keys, {"sub": "alice"})) as c:
        r = await c.post("/v1/shutdown")
        assert r.status_code == 403
    assert not app.state.exit_event.is_set()
