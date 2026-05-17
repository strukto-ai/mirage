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
from mirage.server.host_validation import (DEFAULT_ALLOWED_HOSTS,
                                           parse_allowed_hosts,
                                           resolve_allowed_hosts)


def test_parse_allowed_hosts_defaults_when_missing():
    assert parse_allowed_hosts(None) == list(DEFAULT_ALLOWED_HOSTS)
    assert parse_allowed_hosts("") == list(DEFAULT_ALLOWED_HOSTS)
    assert parse_allowed_hosts("   ") == list(DEFAULT_ALLOWED_HOSTS)


def test_parse_allowed_hosts_csv():
    assert parse_allowed_hosts("a,b,c") == ["a", "b", "c"]
    assert parse_allowed_hosts(" a , b , c ") == ["a", "b", "c"]


def test_parse_allowed_hosts_wildcard_passthrough():
    assert parse_allowed_hosts("*") == ["*"]
    assert parse_allowed_hosts("*,localhost") == ["*", "localhost"]


def test_resolve_allowed_hosts_explicit_wins(monkeypatch):
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "elsewhere")
    assert resolve_allowed_hosts(["override.example"]) == ["override.example"]


def test_resolve_allowed_hosts_env_when_arg_missing(monkeypatch):
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "foo,bar")
    assert resolve_allowed_hosts(None) == ["foo", "bar"]


def test_resolve_allowed_hosts_defaults_when_env_unset(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    assert resolve_allowed_hosts(None) == list(DEFAULT_ALLOWED_HOSTS)


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_rejects_unknown_host(monkeypatch):
    # No env, no explicit arg: middleware enforces loopback allowlist.
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://attacker.example") as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 400


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_accepts_loopback_host(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://127.0.0.1") as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 200
    async with AsyncClient(transport=transport,
                           base_url="http://localhost") as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_env_override_extends_allowlist(monkeypatch):
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS",
                       "127.0.0.1,localhost,daemon.mirage.local")
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://daemon.mirage.local") as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 200
    async with AsyncClient(transport=transport,
                           base_url="http://attacker.example") as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 400


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_explicit_wildcard_disables_enforcement(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0, allowed_hosts=["*"])
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://anything.example") as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_rejection_emits_log_warning(monkeypatch, caplog):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    caplog.set_level("WARNING", logger="mirage.server.host_validation")
    async with AsyncClient(transport=transport,
                           base_url="http://attacker.example") as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 400
    rejection_logs = [
        rec for rec in caplog.records
        if "attacker.example" in rec.getMessage()
    ]
    assert rejection_logs, "expected a warning log for the rejected host"
    assert rejection_logs[0].levelname == "WARNING"
