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
import pytest_asyncio
from aiohttp import web

from mirage.core.github._client import (GitHubApiError, github_headers,
                                        github_request, github_url)
from mirage.core.github.config import GitHubConfig


def test_github_headers_contains_auth():
    headers = github_headers("ghp_test123")
    assert headers["Authorization"] == "Bearer ghp_test123"
    assert headers["Accept"] == "application/vnd.github+json"
    assert "X-GitHub-Api-Version" in headers


def test_github_url_simple():
    url = github_url("/repos/{owner}/{repo}/git/trees/{sha}",
                     owner="acme",
                     repo="proj",
                     sha="abc123")
    assert url == "https://api.github.com/repos/acme/proj/git/trees/abc123"


def test_github_url_no_params():
    url = github_url("/rate_limit")
    assert url == "https://api.github.com/rate_limit"


def test_github_url_none_base_url_falls_back():
    url = github_url("/repos/{owner}/{repo}", None, owner="acme", repo="proj")
    assert url == "https://api.github.com/repos/acme/proj"


def test_github_url_honours_base_url():
    url = github_url("/repos/{owner}/{repo}",
                     "http://127.0.0.1:5095",
                     owner="acme",
                     repo="proj")
    assert url == "http://127.0.0.1:5095/repos/acme/proj"


def test_config_base_url_defaults_to_none():
    assert GitHubConfig(token="ghp_test").base_url is None


def test_config_carries_base_url():
    config = GitHubConfig(token="ghp_test", base_url="http://localhost:1234")
    assert config.base_url == "http://localhost:1234"


SEEN: list[dict] = []
REPLY: dict = {"status": 200, "body": '{"ok":true}'}


async def _echo(request: web.Request) -> web.Response:
    SEEN.append({
        "method": request.method,
        "path": request.path,
        "query": dict(request.query),
        "body": await request.text(),
        "content_type": request.headers.get("Content-Type"),
    })
    return web.Response(status=REPLY["status"],
                        text=REPLY["body"],
                        content_type="application/json")


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


@pytest.mark.asyncio
async def test_request_puts_params_on_the_query_and_no_body_on_a_get(base_url):
    await github_request("t",
                         "GET",
                         "/repos/o/r/git/trees/main",
                         params={"recursive": "1"},
                         base_url=base_url)
    assert SEEN[0]["query"] == {"recursive": "1"}
    assert SEEN[0]["body"] == ""


@pytest.mark.asyncio
async def test_request_sends_a_body_as_json(base_url):
    await github_request("t",
                         "PATCH",
                         "/repos/o/r", {"name": "after"},
                         base_url=base_url)
    assert SEEN[0]["method"] == "PATCH"
    assert SEEN[0]["body"] == '{"name": "after"}'
    assert "application/json" in (SEEN[0]["content_type"] or "")


# Real gh sends nothing for a fieldless call; an empty JSON object plus a
# content type is a different request, and some endpoints read it as one.
@pytest.mark.asyncio
async def test_request_sends_no_body_when_there_is_nothing_to_send(base_url):
    await github_request("t", "DELETE", "/repos/o/r", base_url=base_url)
    assert SEEN[0]["body"] == ""
    assert SEEN[0]["content_type"] is None


# The path arrives from a command line and is used verbatim: a brace in it
# is a brace, never a format placeholder that eats the segment it sits in.
@pytest.mark.asyncio
async def test_request_does_not_format_expand_the_path(base_url):
    await github_request("t",
                         "GET",
                         "/repos/o/r/contents/{tmpl}",
                         base_url=base_url)
    assert SEEN[0]["path"] == "/repos/o/r/contents/{tmpl}"


@pytest.mark.asyncio
async def test_request_decodes_an_empty_response_to_none(base_url):
    REPLY.update({"status": 204, "body": ""})
    assert await github_request("t", "DELETE", "/repos/o/r",
                                base_url=base_url) is None


@pytest.mark.asyncio
async def test_request_raises_with_githubs_own_wording_and_status(base_url):
    REPLY.update({"status": 404, "body": '{"message":"Not Found"}'})
    with pytest.raises(GitHubApiError, match="Not Found") as excinfo:
        await github_request("t", "GET", "/repos/o/r", base_url=base_url)
    assert excinfo.value.status == 404
