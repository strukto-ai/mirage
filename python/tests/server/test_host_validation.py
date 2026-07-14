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
from mirage.server.host_validation import (is_host_allowed,
                                           parse_allowed_hosts,
                                           resolve_allowed_hosts, strip_port)
from mirage.server.host_validation_constants import DEFAULT_ALLOWED_HOSTS


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


def test_strip_port_well_formed():
    assert strip_port("127.0.0.1") == "127.0.0.1"
    assert strip_port("127.0.0.1:8765") == "127.0.0.1"
    assert strip_port("localhost:8765") == "localhost"


def test_strip_port_ipv6_brackets():
    assert strip_port("[::1]") == "::1"
    assert strip_port("[::1]:8765") == "::1"


def test_strip_port_malformed_bracketed_returns_raw():
    assert strip_port("[::1]evil") == "[::1]evil"
    assert strip_port("[::1]:8765x") == "[::1]:8765x"
    assert strip_port("[::1].attacker.tld") == "[::1].attacker.tld"


def test_strip_port_unclosed_bracket_returns_raw():
    assert strip_port("[::1") == "[::1"


def test_strip_port_non_digit_port_returns_raw():
    assert strip_port("127.0.0.1:8765x") == "127.0.0.1:8765x"


def test_strip_port_empty_host_returns_raw():
    assert strip_port(":8765") == ":8765"
    assert strip_port("[]") == "[]"


def test_is_host_allowed_malformed_fail_closed():
    allowed = list(DEFAULT_ALLOWED_HOSTS)
    assert is_host_allowed("[::1]evil", allowed) is False
    assert is_host_allowed("[::1]:8765x", allowed) is False
    assert is_host_allowed("[::1].attacker.tld", allowed) is False


def test_is_host_allowed_accepts_loopback():
    allowed = list(DEFAULT_ALLOWED_HOSTS)
    assert is_host_allowed("[::1]", allowed) is True
    assert is_host_allowed("[::1]:8765", allowed) is True
    assert is_host_allowed("127.0.0.1:8765", allowed) is True


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
async def test_default_accepts_ipv6_loopback_host(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    for base in ("http://[::1]", "http://[::1]:8765"):
        async with AsyncClient(transport=transport, base_url=base) as client:
            r = await client.get("/v1/workspaces")
            assert r.status_code == 200


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_rejects_malformed_bracketed_host(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://127.0.0.1") as client:
        r = await client.get("/v1/workspaces", headers={"host": "[::1]evil"})
        assert r.status_code == 400


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_rejects_non_digit_port(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport,
                           base_url="http://127.0.0.1") as client:
        r = await client.get("/v1/workspaces",
                             headers={"host": "127.0.0.1:8765x"})
        assert r.status_code == 400


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


def test_resolve_allowed_hosts_config_beats_default(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    (tmp_path / "config.toml"
     ).write_text('[daemon]\nallowed_hosts = "example.com,api.example.com"\n')
    assert resolve_allowed_hosts() == ["example.com", "api.example.com"]


def test_resolve_allowed_hosts_env_beats_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "env.example.com")
    (tmp_path / "config.toml"
     ).write_text('[daemon]\nallowed_hosts = "file.example.com"\n')
    assert resolve_allowed_hosts() == ["env.example.com"]
