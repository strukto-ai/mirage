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
import base64
import json
import time
from datetime import UTC, datetime, timedelta

import jwt
import pytest
import pytest_asyncio
from aiohttp import web
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import ValidationError

from mirage.accessor.github import GitHubAccount
from mirage.commands.cli.builtin.gh.repo import token_header
from mirage.core.github.app import REFRESH_MARGIN, AppTokens
from mirage.core.github.client import github_request, github_token
from mirage.core.github.config import GhConfig, GitHubAppAuth, GitHubConfig
from mirage.core.github.repo import login

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
# GitHub's download format, PKCS#1.
PEM = _KEY.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.TraditionalOpenSSL,
    serialization.NoEncryption(),
).decode()
PUBLIC = _KEY.public_key()

SEEN: list[dict] = []
STATE: dict = {}


async def _github(request: web.Request) -> web.Response:
    body = await request.text()
    SEEN.append(
        {
            "method": request.method,
            "path": request.path,
            "authorization": request.headers.get("Authorization"),
            "body": body,
        }
    )
    if request.path == "/app/installations/42/access_tokens":
        STATE["minted"] += 1
        expires = datetime.now(UTC) + timedelta(seconds=STATE["expires_in"])
        return web.json_response(
            {
                "token": f"ghs_{STATE['minted']}",
                "expires_at": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            status=201,
        )
    if request.path == "/installation/repositories":
        repos = STATE["repositories"]
        return web.json_response(
            {"total_count": len(repos), "repositories": repos}
        )
    if request.path == "/user":
        return web.json_response(
            {"message": "Resource not accessible by integration"}, status=403
        )
    return web.json_response({"ok": True})


@pytest_asyncio.fixture()
async def base_url():
    SEEN.clear()
    STATE.update(
        minted=0,
        expires_in=3600,
        repositories=[{"name": "r", "owner": {"login": "acme"}}],
    )
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", _github)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}"
    await runner.cleanup()


def _app(**extra) -> GitHubAppAuth:
    return GitHubAppAuth(
        app_id=7, private_key=PEM, installation_id=42, **extra
    )


def _account(base_url: str, **extra) -> GitHubAccount:
    return GitHubAccount(GhConfig(app=_app(**extra), base_url=base_url))


def _mints() -> list[dict]:
    return [s for s in SEEN if s["path"].endswith("/access_tokens")]


def _calls() -> list[dict]:
    return [s for s in SEEN if not s["path"].endswith("/access_tokens")]


@pytest.mark.asyncio
async def test_mints_an_installation_token_and_rides_it(base_url):
    async with _account(base_url) as account:
        await github_request(account, "GET", "/repos/o/r")
    [mint] = _mints()
    token = mint["authorization"].removeprefix("Bearer ")
    assert jwt.get_unverified_header(token)["alg"] == "RS256"
    claims = jwt.decode(token, PUBLIC, algorithms=["RS256"])
    assert claims["iss"] == "7"
    assert claims["exp"] - claims["iat"] <= 600
    assert claims["iat"] <= time.time() - 30
    assert [s["authorization"] for s in _calls()] == ["Bearer ghs_1"]


@pytest.mark.asyncio
async def test_keeps_a_token_until_it_is_near_expiry(base_url):
    async with _account(base_url) as account:
        await github_request(account, "GET", "/repos/o/r")
        await github_request(account, "GET", "/repos/o/r")
        assert await github_token(account) == "ghs_1"
    assert len(_mints()) == 1


@pytest.mark.asyncio
async def test_mints_the_next_token_five_minutes_before_expiry(base_url):
    STATE["expires_in"] = 240
    async with _account(base_url) as account:
        await github_request(account, "GET", "/repos/o/r")
        await github_request(account, "GET", "/repos/o/r")
    assert len(_mints()) == 2
    assert [s["authorization"] for s in _calls()] == [
        "Bearer ghs_1",
        "Bearer ghs_2",
    ]


@pytest.mark.asyncio
async def test_mints_once_for_concurrent_first_calls(base_url):
    async with _account(base_url) as account:
        await asyncio.gather(
            github_request(account, "GET", "/a"),
            github_request(account, "GET", "/b"),
            github_token(account),
        )
    assert len(_mints()) == 1


@pytest.mark.asyncio
async def test_narrows_the_token_to_repositories_and_permissions(base_url):
    async with _account(
        base_url, repositories=["r"], permissions={"contents": "read"}
    ) as account:
        await github_request(account, "GET", "/repos/o/r")
    assert json.loads(_mints()[0]["body"]) == {
        "repositories": ["r"],
        "permissions": {"contents": "read"},
    }


@pytest.mark.asyncio
async def test_asks_for_no_narrowing_when_none_is_configured(base_url):
    async with _account(base_url) as account:
        await github_request(account, "GET", "/repos/o/r")
    assert json.loads(_mints()[0]["body"] or "{}") == {}


@pytest.mark.asyncio
async def test_clone_header_carries_the_minted_token(base_url):
    async with _account(base_url) as account:
        header = await token_header(account)
    secret = base64.b64encode(b"x-access-token:ghs_1").decode()
    assert header == {"Authorization": f"Basic {secret}"}


@pytest.mark.asyncio
async def test_login_names_the_installation_account_not_user(base_url):
    async with _account(base_url) as account:
        assert await login(account) == "acme"
    assert all(s["path"] != "/user" for s in SEEN)


@pytest.mark.asyncio
async def test_login_refuses_an_installation_reaching_no_repository(
    base_url,
):
    STATE["repositories"] = []
    async with _account(base_url) as account:
        with pytest.raises(ValueError, match='"OWNER/REPO"'):
            await login(account)


@pytest.mark.asyncio
async def test_joined_accounts_share_one_token(base_url):
    first = _account(base_url)
    second = _account(base_url)
    second.join([first])
    async with first, second:
        await github_request(first, "GET", "/a")
        await github_request(second, "GET", "/b")
    assert len(_mints()) == 1


@pytest.mark.asyncio
async def test_app_tokens_mint_again_within_the_margin():
    tokens = AppTokens(_app())
    count = 0

    async def mint() -> tuple[str, float]:
        nonlocal count
        count += 1
        return f"t{count}", time.time() + REFRESH_MARGIN - 1

    assert await tokens.token(mint) == "t1"
    assert await tokens.token(mint) == "t2"


@pytest.mark.parametrize(
    ("got", "auth"),
    [("both", {"token": "t", "app": _app()}), ("neither", {})],
)
def test_config_refuses_both_or_neither(got, auth):
    with pytest.raises(
        ValidationError, match=f"one of token or app; got {got}"
    ):
        GitHubConfig(owner="o", repo="r", **auth)
    with pytest.raises(
        ValidationError, match=f"one of token or app; got {got}"
    ):
        GhConfig(**auth)


def test_config_refuses_an_unknown_key_in_an_app_block():
    with pytest.raises(ValidationError):
        GitHubConfig(
            owner="o",
            repo="r",
            app={
                "app_id": 7,
                "private_key": "k",
                "installation_id": 42,
                "x": 1,
            },
        )


def test_config_keeps_the_private_key_secret():
    config = GitHubConfig(owner="o", repo="r", app=_app())
    assert PEM not in repr(config)
    assert config.app is not None
    assert config.app.private_key.get_secret_value() == PEM
