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
from mirage.server.host_validation import (
    is_cross_origin,
    is_host_allowed,
    parse_allowed_hosts,
    refusal,
    resolve_allowed_hosts,
    strip_port,
)
from mirage.server.host_validation_constants import LOOPBACK_HOSTS

LOOPBACK = list(LOOPBACK_HOSTS)


def test_parse_allowed_hosts_lists_none_when_missing():
    assert parse_allowed_hosts(None) == []
    assert parse_allowed_hosts("") == []
    assert parse_allowed_hosts("   ") == []
    assert parse_allowed_hosts(" , ") == []


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
    assert is_host_allowed("[::1]evil", LOOPBACK) is False
    assert is_host_allowed("[::1]:8765x", LOOPBACK) is False
    assert is_host_allowed("[::1].attacker.tld", LOOPBACK) is False


def test_is_host_allowed_accepts_loopback():
    assert is_host_allowed("[::1]", LOOPBACK) is True
    assert is_host_allowed("[::1]:8765", LOOPBACK) is True
    assert is_host_allowed("127.0.0.1:8765", LOOPBACK) is True


def test_is_host_allowed_ignores_case():
    assert is_host_allowed("LOCALHOST:8765", LOOPBACK) is True
    assert is_host_allowed("Localhost", LOOPBACK) is True


def test_is_host_allowed_refuses_missing_host():
    assert is_host_allowed("", LOOPBACK) is False
    assert is_host_allowed(None, LOOPBACK) is False
    assert is_host_allowed(None, ["*"]) is True


def test_refusal_names_the_setting_not_the_host():
    refused = refusal("attacker.example", None, None, LOOPBACK)
    assert refused is not None
    assert refused.status == 403
    assert refused.code == "host_not_allowed"
    assert (
        refused.message
        == "host is not allowed; add it to MIRAGE_ALLOWED_HOSTS"
    )


def test_refusal_checks_host_before_origin():
    refused = refusal(
        "attacker.example", "https://evil.example", "cross-site", LOOPBACK
    )
    assert refused is not None
    assert refused.code == "host_not_allowed"


def test_refusal_refuses_another_origin():
    refused = refusal("127.0.0.1:8765", "https://evil.example", None, LOOPBACK)
    assert refused is not None
    assert refused.code == "origin_not_allowed"
    assert refused.message == "cross-origin request refused"


def test_refusal_lets_its_own_requests_on():
    assert refusal("127.0.0.1:8765", None, None, LOOPBACK) is None
    assert (
        refusal("localhost:8765", "http://localhost:8765", None, LOOPBACK)
        is None
    )


def test_is_cross_origin_refuses_other_fetch_sites():
    assert is_cross_origin("127.0.0.1:8765", None, "cross-site") is True
    assert (
        is_cross_origin(
            "127.0.0.1:8765", "https://evil.example", "same-origin"
        )
        is True
    )
    assert is_cross_origin("localhost:8765", None, "same-site") is True


def test_is_cross_origin_admits_own_fetch_sites():
    assert is_cross_origin("127.0.0.1:8765", None, "same-origin") is False
    assert is_cross_origin("127.0.0.1:8765", None, "none") is False
    assert is_cross_origin("127.0.0.1:8765", None, None) is False


def test_is_cross_origin_refuses_another_origin():
    for origin in (
        "https://evil.example",
        "http://localhost:3000",
        "http://127.0.0.1",
        "null",
        "",
    ):
        assert is_cross_origin("127.0.0.1:8765", origin, None) is True, origin


def test_is_cross_origin_admits_its_own_origin():
    for host, origin, site in (
        ("127.0.0.1:8765", "http://127.0.0.1:8765", None),
        ("[::1]:8765", "http://[::1]:8765", None),
        ("Localhost:8765", "http://localhost:8765", None),
        ("localhost:8765", "http://LOCALHOST:8765", None),
        ("mirage.example.com", "https://mirage.example.com", "same-origin"),
    ):
        assert is_cross_origin(host, origin, site) is False, origin


def test_resolve_allowed_hosts_explicit_wins(monkeypatch):
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "elsewhere")
    assert resolve_allowed_hosts(["override.example"]) == [
        *LOOPBACK,
        "override.example",
    ]


def test_resolve_allowed_hosts_env_when_arg_missing(monkeypatch):
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "foo,bar")
    assert resolve_allowed_hosts(None) == [*LOOPBACK, "foo", "bar"]


def test_resolve_allowed_hosts_loopback_when_env_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    assert resolve_allowed_hosts(None) == LOOPBACK
    assert resolve_allowed_hosts([]) == LOOPBACK


def test_resolve_allowed_hosts_keeps_each_name_once_bare_and_lower():
    assert resolve_allowed_hosts(
        [
            "Mirage.Example.com:8443",
            "mirage.example.com",
            "[::1]",
            "LOCALHOST",
            "[fd00::1]:8765",
            "*",
        ]
    ) == [*LOOPBACK, "mirage.example.com", "fd00::1", "*"]


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_rejects_unknown_host(monkeypatch):
    # No env, no explicit arg: middleware enforces loopback allowlist.
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://attacker.example"
    ) as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 403


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_accepts_loopback_host(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://127.0.0.1"
    ) as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 200
    async with AsyncClient(
        transport=transport, base_url="http://localhost"
    ) as client:
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
    async with AsyncClient(
        transport=transport, base_url="http://127.0.0.1"
    ) as client:
        r = await client.get("/v1/workspaces", headers={"host": "[::1]evil"})
        assert r.status_code == 403


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_rejects_non_digit_port(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://127.0.0.1"
    ) as client:
        r = await client.get(
            "/v1/workspaces", headers={"host": "127.0.0.1:8765x"}
        )
        assert r.status_code == 403


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_env_adds_to_the_loopback_names(monkeypatch):
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "Daemon.Mirage.Local")
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    for base in (
        "http://daemon.mirage.local",
        "http://127.0.0.1:8765",
        "http://localhost",
    ):
        async with AsyncClient(transport=transport, base_url=base) as client:
            r = await client.get("/v1/workspaces")
            assert r.status_code == 200, base
    async with AsyncClient(
        transport=transport, base_url="http://attacker.example"
    ) as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 403
        assert r.json()["error"] == {
            "code": "host_not_allowed",
            "message": "host is not allowed; add it to MIRAGE_ALLOWED_HOSTS",
        }


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_host_matches_in_any_case(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://127.0.0.1"
    ) as client:
        r = await client.get(
            "/v1/workspaces", headers={"host": "LOCALHOST:8765"}
        )
        assert r.status_code == 200


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_explicit_wildcard_skips_host_check(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0, allowed_hosts=["*"])
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://anything.example"
    ) as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 200


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_rejection_emits_log_warning(monkeypatch, caplog):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    caplog.set_level("WARNING", logger="mirage.server.host_validation")
    async with AsyncClient(
        transport=transport, base_url="http://attacker.example"
    ) as client:
        r = await client.get("/v1/workspaces")
        assert r.status_code == 403
    rejection_logs = [
        rec for rec in caplog.records if "attacker.example" in rec.getMessage()
    ]
    assert rejection_logs, "expected a warning log for the rejected host"
    assert rejection_logs[0].levelname == "WARNING"


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_default_refuses_a_page_on_another_origin(monkeypatch, caplog):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0)
    transport = ASGITransport(app=app)
    caplog.set_level("WARNING", logger="mirage.server.host_validation")
    async with AsyncClient(
        transport=transport, base_url="http://127.0.0.1:8765"
    ) as client:
        for headers in (
            {"origin": "https://evil.example"},
            {"origin": "http://localhost:3000"},
            {"sec-fetch-site": "cross-site"},
        ):
            r = await client.post("/v1/workspaces", headers=headers)
            assert r.status_code == 403, headers
            assert r.json()["error"]["code"] == "origin_not_allowed"
        r = await client.get(
            "/v1/workspaces",
            headers={
                "origin": "http://127.0.0.1:8765",
                "sec-fetch-site": "same-origin",
            },
        )
        assert r.status_code == 200
    assert any("evil.example" in rec.getMessage() for rec in caplog.records)


@pytest.mark.no_host_override
@pytest.mark.asyncio
async def test_wildcard_still_refuses_a_page_on_another_origin(monkeypatch):
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    app = build_app(idle_grace_seconds=10.0, allowed_hosts=["*"])
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://anything.example"
    ) as client:
        r = await client.get(
            "/v1/workspaces", headers={"origin": "https://evil.example"}
        )
        assert r.status_code == 403


def test_resolve_allowed_hosts_config_beats_default(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.delenv("MIRAGE_ALLOWED_HOSTS", raising=False)
    (tmp_path / "config.toml").write_text(
        '[daemon]\nallowed_hosts = "example.com,api.example.com"\n'
    )
    assert resolve_allowed_hosts() == [
        *LOOPBACK,
        "example.com",
        "api.example.com",
    ]


def test_resolve_allowed_hosts_env_beats_config(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "env.example.com")
    (tmp_path / "config.toml").write_text(
        '[daemon]\nallowed_hosts = "file.example.com"\n'
    )
    assert resolve_allowed_hosts() == [*LOOPBACK, "env.example.com"]
