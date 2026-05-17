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

import time
from dataclasses import dataclass

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app
from mirage.server.auth.config import AuthConfig, JWTConfig


@dataclass
class KeyPair:
    private_pem: bytes
    public_pem: bytes


@pytest.fixture(scope="module")
def rsa_keys() -> KeyPair:
    private_key = rsa.generate_private_key(public_exponent=65537,
                                           key_size=2048)
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
    return AsyncClient(transport=transport,
                       base_url="http://test",
                       headers=headers or {})


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_accepts_correct_bearer():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="local",
                                           local_token="correct-token"))
    async with _client(app, {"Authorization": "Bearer correct-token"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_rejects_wrong_bearer():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="local",
                                           local_token="correct-token"))
    async with _client(app, {"Authorization": "Bearer wrong-token"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_rejects_missing_header():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="local",
                                           local_token="correct-token"))
    async with _client(app) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_local_mode_no_token_lets_everything_through():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="local", local_token=None))
    async with _client(app) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_token_mode_accepts_correct_token():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="token",
                                           bearer_token="operator-pat"))
    async with _client(app, {"Authorization": "Bearer operator-pat"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_token_mode_rejects_wrong_token():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="token",
                                           bearer_token="operator-pat"))
    async with _client(app, {"Authorization": "Bearer something-else"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_token_mode_rejects_jwt_shaped_value():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="token",
                                           bearer_token="operator-pat"))
    fake_jwt = "aaaa.bbbb.cccc"
    async with _client(app, {"Authorization": f"Bearer {fake_jwt}"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_accepts_valid_signed(rsa_keys):
    jwt_cfg = JWTConfig(key=rsa_keys.public_pem.decode(), algorithm="RS256")
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg))
    token = pyjwt.encode({
        "sub": "agent",
        "exp": int(time.time()) + 60
    },
                         rsa_keys.private_pem,
                         algorithm="RS256")
    async with _client(app, {"Authorization": f"Bearer {token}"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_rejects_opaque_bearer(rsa_keys):
    jwt_cfg = JWTConfig(key=rsa_keys.public_pem.decode(), algorithm="RS256")
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg))
    async with _client(app, {"Authorization": "Bearer not-a-jwt"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_jwt_mode_rejects_expired(rsa_keys):
    jwt_cfg = JWTConfig(key=rsa_keys.public_pem.decode(),
                        algorithm="RS256",
                        clock_skew_seconds=0)
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="jwt", jwt=jwt_cfg))
    token = pyjwt.encode({
        "sub": "agent",
        "exp": int(time.time()) - 60
    },
                         rsa_keys.private_pem,
                         algorithm="RS256")
    async with _client(app, {"Authorization": f"Bearer {token}"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_health_endpoint_always_open():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="local",
                                           local_token="some-token"))
    async with _client(app) as c:
        r = await c.get("/v1/health")
        assert r.status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_authorization_header_without_bearer_prefix_rejected():
    app = build_app(idle_grace_seconds=10.0,
                    auth_config=AuthConfig(mode="local",
                                           local_token="correct-token"))
    async with _client(app, {"Authorization": "correct-token"}) as c:
        r = await c.get("/v1/workspaces")
        assert r.status_code == 401
