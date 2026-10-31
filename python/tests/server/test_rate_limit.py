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

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request
from starlette.testclient import TestClient, WebSocketDenialResponse

from mirage.server import build_app
from mirage.server.auth import AuthConfig
from mirage.server.daemon_config import DaemonConfigError
from mirage.server.env import ENV_RATE_LIMITS
from mirage.server.rate_limit import (
    RateLimit,
    _value,
    parse_rate_limits,
    resolve_rate_limits,
)


def _client(**kwargs) -> AsyncClient:
    app = build_app(idle_grace_seconds=10.0, **kwargs)
    return AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    )


def test_a_setting_names_its_limits_in_order():
    limits = parse_rate_limits(
        " ip=1000/minute, header:x-tenant=50/seconds,account=10/day,"
    )
    assert [(limit.key, limit.rate) for limit in limits] == [
        ("ip", "1000/minute"),
        ("header:x-tenant", "50/seconds"),
        ("account", "10/day"),
    ]
    assert limits[1].item.amount == 50


@pytest.mark.parametrize(
    "text", ["ip", "ip=0/minute", "ip=1/week", "ip=x/minute", "host=1/second"]
)
def test_a_bad_entry_is_refused(text):
    with pytest.raises(ValueError):
        parse_rate_limits(text)


def test_a_header_key_names_its_header():
    with pytest.raises(ValueError, match="header:<name>"):
        RateLimit("header:", "1/second")


def test_limits_read_the_env_then_config(monkeypatch, tmp_path):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv(ENV_RATE_LIMITS, raising=False)
    assert resolve_rate_limits() == (RateLimit("ip", "1000/minute"),)
    (tmp_path / "config.toml").write_text(
        '[daemon]\nrate_limits = "account=600/minute"\n'
    )
    assert [limit.key for limit in resolve_rate_limits()] == ["account"]
    monkeypatch.setenv(ENV_RATE_LIMITS, "ip=5/second")
    assert [limit.key for limit in resolve_rate_limits()] == ["ip"]
    assert resolve_rate_limits([]) == ()
    monkeypatch.setenv(ENV_RATE_LIMITS, "ip=5")
    with pytest.raises(DaemonConfigError, match="rate_limits"):
        resolve_rate_limits()
    monkeypatch.delenv(ENV_RATE_LIMITS)
    (tmp_path / "config.toml").write_text('[daemon]\nrate_limits = ""\n')
    assert resolve_rate_limits() == ()


@pytest.mark.asyncio
async def test_past_the_rate_a_request_answers_429_until_the_window_ends():
    async with _client(rate_limits=[RateLimit("ip", "2/minute")]) as client:
        assert (await client.get("/v1/workspaces")).status_code == 200
        assert (await client.get("/v1/workspaces")).status_code == 200
        refused = await client.get("/v1/workspaces")
        assert refused.status_code == 429
        assert refused.json() == {"detail": "Too Many Requests"}
        assert 1 <= int(refused.headers["retry-after"]) <= 60
        assert (await client.get("/v1/health")).status_code == 200
        assert (await client.get("/v1/ready")).status_code == 200


@pytest.mark.asyncio
async def test_each_value_of_a_key_counts_on_its_own():
    limits = [RateLimit("header:x-tenant", "1/minute")]
    async with _client(rate_limits=limits) as client:
        first = {"x-tenant": "a"}
        assert (
            await client.get("/v1/workspaces", headers=first)
        ).status_code == 200
        assert (
            await client.get("/v1/workspaces", headers=first)
        ).status_code == 429
        other = {"x-tenant": "b"}
        assert (
            await client.get("/v1/workspaces", headers=other)
        ).status_code == 200
        assert (await client.get("/v1/workspaces")).status_code == 200
        assert (await client.get("/v1/workspaces")).status_code == 200


@pytest.mark.asyncio
async def test_a_workspace_key_counts_the_workspace_the_path_names():
    limits = [RateLimit("workspace", "1/minute")]
    async with _client(rate_limits=limits) as client:
        assert (await client.get("/v1/workspaces/a")).status_code == 404
        assert (
            await client.get("/v1/workspaces/a/sessions")
        ).status_code == 429
        assert (await client.get("/v1/workspaces/b")).status_code == 404
        assert (await client.get("/v1/workspaces")).status_code == 200


@pytest.mark.asyncio
async def test_a_function_key_counts_what_it_answers():
    limits = [RateLimit(lambda request: request.url.path, "1/minute")]
    async with _client(rate_limits=limits) as client:
        assert (await client.get("/v1/workspaces")).status_code == 200
        assert (await client.get("/v1/workspaces")).status_code == 429
        assert (await client.get("/v1/ready")).status_code == 200


@pytest.mark.asyncio
async def test_a_trusted_proxy_names_the_client_an_ip_key_counts():
    limits = [RateLimit("ip", "1/minute")]
    forwarded = [
        {"x-forwarded-for": "10.0.0.1"},
        {"x-forwarded-for": "10.0.0.2"},
    ]
    async with _client(
        rate_limits=limits, forwarded_allow_ips=["*"]
    ) as client:
        for headers in forwarded:
            r = await client.get("/v1/workspaces", headers=headers)
            assert r.status_code == 200
    async with _client(rate_limits=limits) as client:
        statuses = [
            (await client.get("/v1/workspaces", headers=headers)).status_code
            for headers in forwarded
        ]
        assert statuses == [200, 429]


def test_an_account_key_counts_the_signed_in_account():
    scope = {
        "type": "http",
        "path": "/v1/workspaces",
        "headers": [],
        "state": {"account": "alice"},
    }
    assert _value("account", Request(scope)) == "alice"
    assert _value("account", Request({**scope, "state": {}})) is None


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_default_limits_authentication_before_verifying_tokens(
    monkeypatch, caplog, tmp_path
):
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now)
    monkeypatch.delenv(ENV_RATE_LIMITS, raising=False)
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    caplog.set_level("ERROR", logger="mirage.server.auth.middleware")
    auth = AuthConfig(mode="local", local_token="right")
    async with _client(auth_config=auth) as client:
        for i in range(1000):
            response = await client.get(
                "/v1/workspaces",
                headers={
                    "authorization": f"Bearer wrong-{i}",
                    "x-forwarded-for": f"10.0.0.{i % 256}",
                },
            )
            assert response.status_code == 401
        right = {"authorization": "Bearer right"}
        refused = await client.get("/v1/workspaces", headers=right)
        assert refused.status_code == 429
        assert refused.json() == {"detail": "Too Many Requests"}
        assert refused.headers["retry-after"] == "60"
        assert (await client.get("/v1/health")).status_code == 200
        assert (await client.get("/v1/ready")).status_code == 200
        now += 61
        assert (
            await client.get("/v1/workspaces", headers=right)
        ).status_code == 200


@pytest.mark.asyncio
async def test_an_explicit_empty_list_disables_the_default():
    async with _client(rate_limits=[]) as client:
        for _ in range(1001):
            assert (await client.get("/v1/workspaces")).status_code == 200


@pytest.mark.no_auth_override
@pytest.mark.asyncio
async def test_an_ip_limit_counts_requests_a_bad_token_brings():
    app = build_app(
        idle_grace_seconds=10.0,
        auth_config=AuthConfig(mode="local", local_token="right"),
        rate_limits=[
            RateLimit("ip", "1/minute"),
            RateLimit("account", "1/minute"),
        ],
    )
    wrong = {"Authorization": "Bearer wrong"}
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (
            await client.get("/v1/workspaces", headers=wrong)
        ).status_code == 401
        assert (
            await client.get("/v1/workspaces", headers=wrong)
        ).status_code == 429


@pytest.mark.asyncio
async def test_a_bare_upgrade_header_is_still_counted():
    limits = [RateLimit("ip", "1/minute")]
    upgrade = {"upgrade": "websocket"}
    async with _client(rate_limits=limits) as client:
        assert (
            await client.get("/v1/workspaces", headers=upgrade)
        ).status_code == 200
        assert (
            await client.get("/v1/workspaces", headers=upgrade)
        ).status_code == 429


def test_websocket_handshakes_share_the_http_authentication_budget():
    app = build_app(
        auth_config=AuthConfig(mode="local", local_token="right"),
        rate_limits=[RateLimit("ip", "1/minute")],
    )
    with TestClient(app, base_url="http://test") as client:
        for status in (401, 429):
            with pytest.raises(WebSocketDenialResponse) as denied:
                with client.websocket_connect(
                    "/v1/workspaces/missing/ssh",
                    headers={"authorization": "Bearer wrong"},
                ):
                    pytest.fail("an invalid bearer must not open a WebSocket")
            assert denied.value.status_code == status
            if status == 429:
                assert 1 <= int(denied.value.headers["retry-after"]) <= 60
        assert client.get("/v1/workspaces").status_code == 429


@pytest.mark.asyncio
async def test_a_refusal_logs_the_limit_not_the_value(caplog):
    limits = [RateLimit("header:authorization", "1/minute")]
    token = {"authorization": "Bearer secret-token"}
    async with _client(rate_limits=limits) as client:
        await client.get("/v1/workspaces", headers=token)
        with caplog.at_level("WARNING", logger="mirage.server.rate_limit"):
            r = await client.get("/v1/workspaces", headers=token)
    assert r.status_code == 429
    assert "secret-token" not in caplog.text
    assert "header:authorization=1/minute" in caplog.text
