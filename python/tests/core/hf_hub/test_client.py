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
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestServer
from pydantic import SecretStr

from mirage.accessor.hf_hub import HfAccountAccessor
from mirage.core.hf_hub.client import (
    WRITE_RETRY,
    HfHubError,
    _error_of,
    api_url,
    etag_value,
    hub_bytes_tagged,
    hub_headers,
    hub_post,
    hub_post_ndjson,
    hub_request,
    hub_stream,
    quote_path,
    resolve_url,
    rev_segment,
)
from mirage.core.hf_hub.config import HfConfig
from mirage.core.hf_hub.constants import MAX_RETRIES
from mirage.utils.ranges import ByteWindow


def test_hub_headers_omit_authorization_without_a_token():
    assert hub_headers(None) == {"Accept": "application/json"}


def test_hub_headers_carry_a_bearer_token():
    headers = hub_headers(SecretStr("tok"))
    assert headers["Authorization"] == "Bearer tok"


@pytest.mark.parametrize(
    "repo_type,expected",
    [
        ("model", "https://huggingface.co/api/models/a/b/refs"),
        ("dataset", "https://huggingface.co/api/datasets/a/b/refs"),
        ("space", "https://huggingface.co/api/spaces/a/b/refs"),
    ],
)
def test_api_url_pluralizes_every_repo_type(repo_type, expected):
    assert (
        api_url("https://huggingface.co", repo_type, "a/b", "/refs")
        == expected
    )


@pytest.mark.parametrize(
    "repo_type,expected",
    [
        ("model", "https://huggingface.co/a/b/resolve/main/f.json"),
        ("dataset", "https://huggingface.co/datasets/a/b/resolve/main/f.json"),
        ("space", "https://huggingface.co/spaces/a/b/resolve/main/f.json"),
    ],
)
def test_resolve_url_puts_a_model_at_the_bare_repo_id(repo_type, expected):
    """The content host is not the API host's table.

    A model's files hang off the bare repo id while a dataset's and a
    space's sit under their own segment, so reusing the API's plural
    here would 404 every model read.
    """
    assert (
        resolve_url(
            "https://huggingface.co", repo_type, "a/b", "main", "f.json"
        )
        == expected
    )


def test_resolve_url_percent_encodes_the_path():
    url = resolve_url(
        "https://huggingface.co", "model", "a/b", "main", "dir/a file#1.txt"
    )
    assert url.endswith("/resolve/main/dir/a%20file%231.txt")


def test_resolve_url_keeps_slashes_between_segments():
    url = resolve_url(
        "https://huggingface.co", "model", "a/b", "main", "deep/nested/f.txt"
    )
    assert url.endswith("/resolve/main/deep/nested/f.txt")


def test_error_of_prefers_the_hub_error_header():
    resp = MagicMock(status=404, reason="Not Found")
    resp.headers = {"X-Error-Message": "Entry not found"}
    err = _error_of(resp, '{"error":"whatever"}')
    assert isinstance(err, HfHubError)
    assert str(err) == "Entry not found"
    assert err.status == 404


def test_error_of_falls_back_to_the_body():
    resp = MagicMock(status=500, reason="Server Error")
    resp.headers = {}
    err = _error_of(resp, "  boom  ")
    assert str(err) == "boom"
    assert err.status == 500


def test_rev_segment_encodes_a_slash():
    """A git ref may hold a slash, and every Hub route reads the segment
    after the verb as the whole revision, so an unencoded one splits."""
    assert rev_segment("feature/foo") == "feature%2Ffoo"
    assert rev_segment("refs/pr/1") == "refs%2Fpr%2F1"


def test_rev_segment_leaves_an_ordinary_ref_alone():
    assert rev_segment("main") == "main"
    assert rev_segment("v1.0.0-rc.1") == "v1.0.0-rc.1"


def test_error_of_reads_the_error_code_header():
    # walk_pages folds a missing subtree by this code alone, so it has to
    # survive from the header onto the exception.
    resp = MagicMock(status=404, reason="Not Found")
    resp.headers = {"X-Error-Code": "EntryNotFound"}
    assert _error_of(resp, "").error_code == "EntryNotFound"


def test_error_of_without_a_code_is_empty():
    resp = MagicMock(status=401, reason="Unauthorized")
    resp.headers = {}
    assert _error_of(resp, "").error_code == ""


@pytest.mark.parametrize(
    "raw,expected",
    [
        ('"abc"', "abc"),
        ('W/"abc"', "abc"),
        ("abc", "abc"),
        ("", ""),
    ],
)
def test_etag_value_strips_the_weak_prefix_and_quotes(raw, expected):
    assert etag_value(raw) == expected


SEEN: list[dict] = []
STALL = 0.3
SERVE: dict = {"body": b"0123456789", "ignore_range": False}


async def _resolve(_request: web.Request) -> web.Response:
    # The first hop's ETag differs from the bytes', as the live Hub's does
    # (x-linked-etag names the LFS sha); only the final one is the token.
    raise web.HTTPFound("/cdn", headers={"ETag": '"first-hop"'})


async def _cdn(request: web.Request) -> web.Response:
    SEEN.append({"range": request.headers.get("Range")})
    body = SERVE["body"]
    headers = {"ETag": '"final-hop"'}
    span = request.headers.get("Range", "")
    if span and not SERVE["ignore_range"]:
        first, _, last = span[len("bytes=") :].partition("-")
        return web.Response(
            status=206, body=body[int(first) : int(last) + 1], headers=headers
        )
    return web.Response(body=body, headers=headers)


async def _drip(request: web.Request) -> web.StreamResponse:
    # Each chunk lands inside the stall bound, the whole body well past it.
    resp = web.StreamResponse()
    await resp.prepare(request)
    for chunk in (b"ab", b"cd", b"ef", b"gh"):
        await asyncio.sleep(STALL / 2)
        await resp.write(chunk)
    await resp.write_eof()
    return resp


async def _stall(request: web.Request) -> web.StreamResponse:
    resp = web.StreamResponse()
    await resp.prepare(request)
    await resp.write(b"ab")
    await asyncio.sleep(STALL * 4)
    return resp


async def _post(request: web.Request) -> web.Response:
    SEEN.append({"content_type": request.headers.get("Content-Type")})
    return web.json_response([])


@pytest_asyncio.fixture()
async def hub_url():
    SEEN.clear()
    SERVE.update({"body": b"0123456789", "ignore_range": False})
    app = web.Application()
    app.router.add_get("/resolve", _resolve)
    app.router.add_get("/cdn", _cdn)
    app.router.add_post("/post", _post)
    app.router.add_get("/drip", _drip)
    app.router.add_get("/stall", _stall)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    yield f"http://127.0.0.1:{port}"
    await runner.cleanup()


@pytest_asyncio.fixture()
async def account():
    async with HfAccountAccessor(HfConfig()) as account:
        yield account


@pytest.mark.asyncio
async def test_hub_bytes_tagged_returns_the_final_hops_etag(hub_url, account):
    data, etag = await hub_bytes_tagged(account, hub_url + "/resolve")
    assert (data, etag) == (b"0123456789", '"final-hop"')


@pytest.mark.asyncio
async def test_hub_bytes_tagged_sends_the_window(hub_url, account):
    data, _ = await hub_bytes_tagged(
        account, hub_url + "/resolve", ByteWindow(2, 3)
    )
    assert data == b"234"
    assert SEEN[-1]["range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_hub_bytes_tagged_trims_an_ignored_range(hub_url, account):
    SERVE["ignore_range"] = True
    data, _ = await hub_bytes_tagged(
        account, hub_url + "/resolve", ByteWindow(2, 3)
    )
    assert data == b"234"


@pytest.mark.asyncio
async def test_hub_stream_reports_the_final_headers_before_the_first_chunk(
    hub_url, account
):
    order: list[str] = []
    seen: list[dict] = []

    def on_response(headers) -> None:
        order.append("headers")
        seen.append(dict(headers))

    async for chunk in hub_stream(
        account, hub_url + "/resolve", 4, on_response=on_response
    ):
        order.append(chunk.decode())
    assert order == ["headers", "0123", "4567", "89"]
    # Keys are lower-cased, so a reader's .get("etag") finds the server's
    # "ETag" whatever case it was sent in.
    assert seen[0]["etag"] == '"final-hop"'


@pytest.mark.asyncio
async def test_hub_stream_reports_headers_for_an_empty_file(hub_url, account):
    SERVE["body"] = b""
    calls: list[dict] = []
    chunks = [
        c
        async for c in hub_stream(
            account, hub_url + "/resolve", 4, on_response=calls.append
        )
    ]
    # An empty file yields no chunk, so a callback fired lazily on the
    # first one would never stamp it.
    assert chunks == []
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_hub_post_sends_a_json_content_type(hub_url, account):
    # The live Hub answers a paths-info body without it with 400.
    await hub_post(account, hub_url + "/post", {"paths": ["a.txt"]})
    assert SEEN[-1]["content_type"] == "application/json"


def test_quote_path_encodes_each_segment_without_a_leading_slash():
    assert quote_path("/a dir/f#1.txt") == "a%20dir/f%231.txt"


@pytest.mark.asyncio
@pytest.mark.parametrize("seconds", [0, -1])
async def test_a_download_under_no_bound_is_not_cut_off(hub_url, seconds):
    async with HfAccountAccessor(HfConfig(), timeout=seconds) as account:
        chunks = [c async for c in hub_stream(account, hub_url + "/drip", 2)]
    assert b"".join(chunks) == b"abcdefgh"


@pytest.mark.asyncio
async def test_a_download_that_keeps_flowing_outlives_the_bound(hub_url):
    async with HfAccountAccessor(HfConfig(), timeout=STALL) as account:
        chunks = [c async for c in hub_stream(account, hub_url + "/drip", 2)]
    assert b"".join(chunks) == b"abcdefgh"


@pytest.mark.asyncio
async def test_a_download_that_stops_flowing_fails_at_the_bound(hub_url):
    async with HfAccountAccessor(HfConfig(), timeout=STALL) as account:
        with pytest.raises(asyncio.TimeoutError):
            async for _ in hub_stream(account, hub_url + "/stall", 2):
                pass


async def _no_sleep(seconds: float) -> None:
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("send", "sent"),
    [
        (lambda a, url: hub_post(a, url, {}), MAX_RETRIES + 1),
        (lambda a, url: hub_post(a, url, {}, retry=WRITE_RETRY), 1),
        (lambda a, url: hub_post_ndjson(a, url, b"{}"), 1),
        (lambda a, url: hub_request(a, "DELETE", url, None), 1),
    ],
)
async def test_a_dropped_connection_is_resent_for_a_read_never_a_write(
    monkeypatch, send, sent
):
    hits: list[str] = []

    async def drop(request: web.Request) -> web.Response:
        hits.append(request.method)
        assert request.transport is not None
        request.transport.close()
        return web.Response()

    monkeypatch.setattr(asyncio, "sleep", _no_sleep)
    app = web.Application()
    app.router.add_route("*", "/x", drop)
    async with TestServer(app) as server:
        async with HfAccountAccessor(HfConfig()) as account:
            with pytest.raises(Exception):
                await send(account, str(server.make_url("/x")))
    assert len(hits) == sent
