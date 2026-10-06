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
from httpx import ASGITransport, AsyncClient

from mirage.server import build_app
from mirage.server.auth import AuthConfig
from mirage.server.auth.config import JWTConfig

PATH = "/.well-known/oauth-protected-resource"


async def _get(config: AuthConfig, tmp_path) -> tuple[int, dict]:
    app = build_app(auth_config=config, state_root=tmp_path / "state")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765"
    ) as client:
        r = await client.get(PATH)
    return r.status_code, r.json()


@pytest.mark.asyncio
async def test_a_server_with_a_login_client_says_where_to_log_in(tmp_path):
    status, body = await _get(
        AuthConfig(
            mode="jwt",
            jwt=JWTConfig(
                algorithm="RS256",
                jwks_url="https://clerk.example/.well-known/jwks.json",
                issuer="https://clerk.example",
                audiences=("client_cli",),
                login_client_id="client_cli",
            ),
        ),
        tmp_path,
    )
    assert status == 200
    assert body == {
        "resource": "http://127.0.0.1:8765",
        "authorization_servers": ["https://clerk.example"],
        "bearer_methods_supported": ["header"],
        "client_id": "client_cli",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config",
    [
        AuthConfig(mode="local", local_token="t"),
        AuthConfig(mode="token", bearer_token="t"),
        AuthConfig(
            mode="jwt",
            jwt=JWTConfig(algorithm="HS256", key="s" * 32, issuer="i"),
        ),
    ],
    ids=["local", "token", "jwt_without_login"],
)
async def test_a_server_without_one_publishes_no_login(config, tmp_path):
    status, _ = await _get(config, tmp_path)
    assert status == 404
