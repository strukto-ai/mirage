from unittest.mock import AsyncMock

import pytest

from mirage.commands.cli.builtin.gh import GH, auth
from mirage.core.github.client import GitHubApiError
from mirage.workspace import Workspace


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "base,host",
    [
        (None, "github.com"),
        ("https://enterprise.test/api/v3", "enterprise.test"),
    ],
)
async def test_status_checks_configured_token_without_mounts(
    monkeypatch, base, host
):
    login = AsyncMock(return_value="alice")
    monkeypatch.setattr(auth, "login", login)
    with Workspace({}) as ws:
        ws.register_cli(
            "gh", GH, {"token": "secret-never-print", "base_url": base}
        )
        result = await ws.shell("gh auth status")
        assert result.exit_code == 0
        text = await result.stdout_str()
        assert "account alice (Mirage configuration)" in text
        assert (await result.stdout_str()).startswith(host + "\n")
        assert "secret-never-print" not in await result.stdout_str()
        assert login.await_count == 1


@pytest.mark.asyncio
async def test_rejected_token_has_failure_status(monkeypatch):
    monkeypatch.setattr(
        auth,
        "login",
        AsyncMock(side_effect=GitHubApiError("Bad credentials", 401)),
    )
    with Workspace({}) as ws:
        ws.register_cli("gh", GH, {"token": "secret-never-print"})
        result = await ws.shell("gh auth status")
        assert result.exit_code == 1
        assert not result.stdout
        assert "HTTP 401" in await result.stderr_str()
        assert "secret-never-print" not in await result.stderr_str()


@pytest.mark.asyncio
async def test_token_is_refused_for_the_configured_host():
    with Workspace({}) as ws:
        ws.register_cli(
            "gh",
            GH,
            {
                "token": "secret-never-print",
                "base_url": "https://ghe.test/api/v3",
            },
        )
        result = await ws.shell("gh auth token")
        assert (result.exit_code, result.stdout) == (1, b"")
        assert await result.stderr_str() == (
            "gh auth token: the token for ghe.test stays in Mirage "
            "configuration and is never printed; gh commands use it "
            "directly\n"
        )
