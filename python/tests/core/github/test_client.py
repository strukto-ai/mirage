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

import socket

import pytest
import pytest_asyncio
from aiohttp import web

from mirage.accessor.github import GitHubAccount
from mirage.core.github.client import (
    GitHubApiError,
    GitHubConnectionError,
    github_headers,
    github_request,
    github_request_response,
    github_url,
    graphql_url,
)
from mirage.core.github.config import GhConfig, GitHubConfig


def test_github_headers_contains_auth():
    headers = github_headers("ghp_test123")
    assert headers["Authorization"] == "Bearer ghp_test123"
    assert headers["Accept"] == "application/vnd.github+json"
    assert "X-GitHub-Api-Version" in headers


def test_github_url_simple():
    url = github_url(
        "/repos/{owner}/{repo}/git/trees/{sha}",
        owner="acme",
        repo="proj",
        sha="abc123",
    )
    assert url == "https://api.github.com/repos/acme/proj/git/trees/abc123"


def test_github_url_no_params():
    url = github_url("/rate_limit")
    assert url == "https://api.github.com/rate_limit"


def test_github_url_none_base_url_falls_back():
    url = github_url("/repos/{owner}/{repo}", None, owner="acme", repo="proj")
    assert url == "https://api.github.com/repos/acme/proj"


def test_github_url_honours_base_url():
    url = github_url(
        "/repos/{owner}/{repo}",
        "http://127.0.0.1:5095",
        owner="acme",
        repo="proj",
    )
    assert url == "http://127.0.0.1:5095/repos/acme/proj"


def test_config_base_url_defaults_to_none():
    assert GitHubConfig(token="ghp_test").base_url is None


def test_config_carries_base_url():
    config = GitHubConfig(token="ghp_test", base_url="http://localhost:1234")
    assert config.base_url == "http://localhost:1234"


SEEN: list[dict] = []
REPLY: dict = {"status": 200, "body": '{"ok":true}'}


async def _echo(request: web.Request) -> web.Response:
    SEEN.append(
        {
            "method": request.method,
            "path": request.path,
            "query": dict(request.query),
            "body": await request.text(),
            "content_type": request.headers.get("Content-Type"),
            "accept": request.headers.get("Accept"),
        }
    )
    if isinstance(REPLY["body"], bytes):
        return web.Response(
            status=REPLY["status"],
            body=REPLY["body"],
            content_type=REPLY["content_type"],
        )
    return web.Response(
        status=REPLY["status"],
        text=REPLY["body"],
        content_type="application/json",
        headers={"X-Page": "next"},
    )


@pytest_asyncio.fixture()
async def base_url():
    SEEN.clear()
    REPLY.update({"status": 200, "body": '{"ok":true}'})
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", _echo)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}"
    await runner.cleanup()


def _account(base_url: str) -> GitHubAccount:
    return GitHubAccount(GhConfig(token="t", base_url=base_url))


@pytest_asyncio.fixture()
async def account(base_url):
    async with _account(base_url) as account:
        yield account


@pytest.mark.asyncio
async def test_request_puts_params_on_the_query_and_no_body_on_a_get(account):
    await github_request(
        account, "GET", "/repos/o/r/git/trees/main", params={"recursive": "1"}
    )
    assert SEEN[0]["query"] == {"recursive": "1"}
    assert SEEN[0]["body"] == ""


@pytest.mark.asyncio
async def test_request_sends_a_body_as_json(account):
    await github_request(account, "PATCH", "/repos/o/r", {"name": "after"})
    assert SEEN[0]["method"] == "PATCH"
    assert SEEN[0]["body"] == '{"name": "after"}'
    assert "application/json" in (SEEN[0]["content_type"] or "")


# Real gh sends nothing for a fieldless call; an empty JSON object plus a
# content type is a different request, and some endpoints read it as one.
@pytest.mark.asyncio
async def test_request_sends_no_body_when_there_is_nothing_to_send(account):
    await github_request(account, "DELETE", "/repos/o/r")
    assert SEEN[0]["body"] == ""
    assert SEEN[0]["content_type"] is None


@pytest.mark.asyncio
async def test_request_sends_an_explicit_json_null(account):
    await github_request(account, "POST", "/repos/o/r", None)
    assert SEEN[0]["body"] == "null"
    assert "application/json" in (SEEN[0]["content_type"] or "")


# The path arrives from a command line and is used verbatim: a brace in it
# is a brace, never a format placeholder that eats the segment it sits in.
@pytest.mark.asyncio
async def test_request_does_not_format_expand_the_path(account):
    await github_request(account, "GET", "/repos/o/r/contents/{tmpl}")
    assert SEEN[0]["path"] == "/repos/o/r/contents/{tmpl}"


@pytest.mark.asyncio
async def test_request_decodes_an_empty_response_to_none(account):
    REPLY.update({"status": 204, "body": ""})
    assert await github_request(account, "DELETE", "/repos/o/r") is None


@pytest.mark.asyncio
async def test_request_response_retains_metadata_and_overrides_headers(
    account,
):
    response = await github_request_response(
        account, "GET", "/repos/o/r", headers={"accept": "text/plain"}
    )
    assert SEEN[0]["accept"] == "text/plain"
    assert response.status == 200
    assert response.data == {"ok": True}
    assert response.headers["x-page"] == "next"


@pytest.mark.asyncio
async def test_request_raises_with_githubs_own_wording_and_status(account):
    REPLY.update({"status": 404, "body": '{"message":"Not Found"}'})
    with pytest.raises(GitHubApiError, match="Not Found") as excinfo:
        await github_request(account, "GET", "/repos/o/r")
    assert excinfo.value.status == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,data,message",
    [
        (
            ' {"message":"Validation Failed", "errors":[{"message":"bad query"}]}\n',
            {
                "message": "Validation Failed",
                "errors": [{"message": "bad query"}],
            },
            "Validation Failed",
        ),
        (
            "upstream unavailable\n",
            "upstream unavailable\n",
            "Unprocessable Entity",
        ),
        ("", None, "Unprocessable Entity"),
    ],
)
async def test_request_error_preserves_wire_body_and_request_url(
    account, base_url, body, data, message
):
    REPLY.update({"status": 422, "body": body})
    with pytest.raises(GitHubApiError) as caught:
        await github_request(
            account, "GET", "/search/issues", params={"q": "bad query"}
        )
    error = caught.value
    assert str(error) == message
    assert error.body == body
    assert error.data == data
    assert error.url == f"{base_url}/search/issues?q=bad+query"
    assert error.status == 422


# gh's GraphQLEndpoint beside its RESTPrefix (cli/cli internal/ghinstance):
# an Enterprise Server serves GraphQL at /api/graphql, outside /api/v3.
@pytest.mark.parametrize(
    "base,url",
    [
        (None, "https://api.github.com/graphql"),
        ("https://api.github.com", "https://api.github.com/graphql"),
        ("https://ghe.example/api/v3", "https://ghe.example/api/graphql"),
        ("https://ghe.example/api/v3/", "https://ghe.example/api/graphql"),
        ("http://127.0.0.1:5098", "http://127.0.0.1:5098/graphql"),
        (
            "http://127.0.0.1:5098/api/v3x",
            "http://127.0.0.1:5098/api/v3x/graphql",
        ),
    ],
)
def test_graphql_url_pairs_with_the_rest_base_as_gh_does(base, url):
    assert graphql_url(base) == url


@pytest.mark.asyncio
async def test_graphql_goes_outside_an_enterprise_rest_base(base_url):
    # A slash-led `/graphql` is a REST path, as `gh api /graphql` is in gh.
    async with _account(base_url + "/api/v3") as account:
        query = {"query": "{ viewer { login } }"}
        await github_request(account, "POST", "graphql", query)
        await github_request(account, "GET", "/repos/o/r")
        await github_request(account, "GET", "/graphql")
    assert [(seen["method"], seen["path"]) for seen in SEEN] == [
        ("POST", "/api/graphql"),
        ("GET", "/api/v3/repos/o/r"),
        ("GET", "/api/v3/graphql"),
    ]


# `gh api -i` prints a failing response's headers as it prints any other's.
@pytest.mark.asyncio
async def test_request_error_carries_the_response_headers(account):
    REPLY.update({"status": 404, "body": '{"message":"Not Found"}'})
    with pytest.raises(GitHubApiError) as caught:
        await github_request(account, "GET", "/repos/o/r")
    assert caught.value.headers["x-page"] == "next"
    assert caught.value.headers["content-type"].startswith("application/json")


@pytest.mark.asyncio
async def test_request_hands_a_binary_body_back_as_bytes(account):
    REPLY.update(
        {
            "status": 200,
            "body": b"PK\x05\x06\xff",
            "content_type": "application/zip",
        }
    )
    assert (
        await github_request(account, "GET", "/repos/o/r/actions/runs/1/logs")
        == b"PK\x05\x06\xff"
    )


@pytest.mark.asyncio
async def test_request_reads_a_text_body_as_text(account):
    REPLY.update(
        {"status": 200, "body": b"line one\n", "content_type": "text/plain"}
    )
    assert (
        await github_request(account, "GET", "/repos/o/r/actions/jobs/1/logs")
        == "line one\n"
    )


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# A call that got no response is no status at all: gh names the failure and
# exits at once. Measured against gh 2.85 (2026-09-30): a refused connection
# reads as Go's client reports it, an unknown host as printError words it.
@pytest.mark.asyncio
async def test_a_refused_connection_is_named_as_go_names_it():
    port = _closed_port()
    async with _account(f"http://127.0.0.1:{port}") as account:
        with pytest.raises(GitHubConnectionError) as caught:
            await github_request(
                account, "GET", "/repos/o/r", params={"per_page": "1"}
            )
    assert str(caught.value) == (
        f'Get "http://127.0.0.1:{port}/repos/o/r?per_page=1": '
        f"dial tcp 127.0.0.1:{port}: connect: connection refused"
    )


@pytest.mark.asyncio
async def test_a_host_that_does_not_resolve_is_named_as_gh_names_it():
    async with _account("http://nowhere.invalid") as account:
        with pytest.raises(GitHubConnectionError) as caught:
            await github_request(account, "POST", "/repos/o/r/issues", {})
    assert str(caught.value) == (
        "error connecting to nowhere.invalid\n"
        "check your internet connection or https://githubstatus.com"
    )
