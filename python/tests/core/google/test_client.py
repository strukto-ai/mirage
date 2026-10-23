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
import time
from typing import Any
from unittest.mock import AsyncMock, patch

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from aioresponses import aioresponses
from yarl import URL

from mirage.core.google.client import (
    READ_RETRY,
    TokenManager,
    calendar_base,
    docs_base,
    drive_base,
    drive_upload_base,
    forms_base,
    gmail_base,
    google_delete,
    google_error_message,
    google_get,
    google_get_bytes,
    google_get_stream,
    google_headers,
    google_patch,
    google_post,
    google_request,
    google_resumable,
    google_send_bytes,
    refresh_access_token,
    sheets_base,
    slides_base,
    token_url,
    transient,
)
from mirage.core.google.config import GoogleConfig
from mirage.core.google.constants import (
    CALENDAR_API_BASE,
    DOCS_API_BASE,
    DRIVE_API_BASE,
    DRIVE_UPLOAD_BASE,
    FORMS_API_BASE,
    GMAIL_API_BASE,
    MAX_RETRIES,
    SHEETS_API_BASE,
    SLIDES_API_BASE,
    TOKEN_URL,
)
from mirage.core.gsheets.write import append_values, update_values
from mirage.io.spool import ByteSpool

API_ERROR = (
    '{"error": {"code": 400, "message": "Unsupported request: '
    'insertDimension", "status": "INVALID_ARGUMENT"}}'
)
TOKEN_ERROR = (
    '{"error": "invalid_grant", "error_description": '
    '"Token has been expired or revoked."}'
)
FILES = "https://drive.test/drive/v3/files"


def _reason(code: int, reason: str) -> str:
    return (
        f'{{"error": {{"code": {code}, "message": "{reason}", '
        f'"errors": [{{"domain": "usageLimits", "reason": "{reason}"}}]}}}}'
    )


def _signed_in(waits: list[float]) -> TokenManager:
    async def _record(seconds: float) -> None:
        waits.append(seconds)

    tm = TokenManager(
        GoogleConfig(client_id="cid", refresh_token="rt"), sleep=_record
    )
    tm.get_token = AsyncMock(return_value="tok")
    return tm


def _manager(api_base: str | None = None) -> TokenManager:
    return TokenManager(
        GoogleConfig(client_id="cid", refresh_token="rt", api_base=api_base)
    )


def test_bases_default_to_real_google_hosts():
    tm = _manager()
    assert drive_base(tm) == DRIVE_API_BASE
    assert drive_upload_base(tm) == DRIVE_UPLOAD_BASE
    assert docs_base(tm) == DOCS_API_BASE
    assert slides_base(tm) == SLIDES_API_BASE
    assert sheets_base(tm) == SHEETS_API_BASE
    assert gmail_base(tm) == GMAIL_API_BASE
    assert calendar_base(tm) == CALENDAR_API_BASE
    assert forms_base(tm) == FORMS_API_BASE
    assert token_url(tm.config) == TOKEN_URL


def test_api_base_override_rewrites_every_service():
    tm = _manager("http://127.0.0.1:19999")
    assert drive_base(tm) == "http://127.0.0.1:19999/drive/v3"
    assert drive_upload_base(tm) == "http://127.0.0.1:19999/upload/drive/v3"
    assert docs_base(tm) == "http://127.0.0.1:19999/v1"
    assert slides_base(tm) == "http://127.0.0.1:19999/v1"
    assert sheets_base(tm) == "http://127.0.0.1:19999/v4"
    assert gmail_base(tm) == "http://127.0.0.1:19999/gmail/v1"
    assert calendar_base(tm) == "http://127.0.0.1:19999/calendar/v3"
    assert forms_base(tm) == "http://127.0.0.1:19999/v1"
    assert token_url(tm.config) == "http://127.0.0.1:19999/token"


def test_api_error_message_comes_from_the_body():
    assert (
        google_error_message(API_ERROR, 400, "Bad Request")
        == "Unsupported request: insertDimension"
    )


def test_token_endpoint_error_shape_is_flat():
    assert (
        google_error_message(TOKEN_ERROR, 400, "Bad Request")
        == "invalid_grant: Token has been expired or revoked."
    )


def test_non_json_body_is_reported_verbatim():
    assert (
        google_error_message("<html>gateway</html>", 502, "Bad Gateway")
        == "<html>gateway</html>"
    )


def test_empty_body_falls_back_to_the_reason_then_the_status():
    assert google_error_message("", 404, "Not Found") == "Not Found"
    assert google_error_message("   ", 404, None) == "HTTP 404"


def _refresh_returning(*tokens: str):
    return patch(
        "mirage.core.google.client.refresh_access_token",
        new_callable=AsyncMock,
        side_effect=[(t, 3600) for t in tokens],
    )


@pytest.mark.asyncio
async def test_token_manager_refreshes_once_then_caches():
    mgr = _manager()
    with _refresh_returning("cached-token") as refresh:
        assert await mgr.get_token() == "cached-token"
        assert await mgr.get_token() == "cached-token"
    refresh.assert_called_once_with(mgr.config, mgr.sleep)


@pytest.mark.asyncio
async def test_token_manager_refreshes_when_expired():
    mgr = _manager()
    with _refresh_returning("token-1", "token-2"):
        await mgr.get_token()
        mgr._expires_at = time.time() - 1
        assert await mgr.get_token() == "token-2"


@pytest.mark.asyncio
async def test_google_headers_carry_the_bearer_token():
    with _refresh_returning("my-token"):
        headers = await google_headers(_manager())
    assert headers["Authorization"] == "Bearer my-token"


@pytest.mark.asyncio
async def test_a_stream_closed_early_closes_its_download():
    closed: list[bool] = []

    async def download(url, **kwargs):
        try:
            yield b"a"
            yield b"b"
        finally:
            closed.append(True)

    tm = _manager()
    tm.get_token = AsyncMock(return_value="tok")
    with patch("mirage.core.google.client.api_stream", download):
        stream = google_get_stream(tm, "https://drive.test/f")
        assert await anext(stream) == b"a"
        await stream.aclose()
    assert closed == [True]


@pytest.mark.asyncio
@pytest.mark.parametrize("advance", [True, False])
async def test_resumable_upload_honors_acknowledged_ranges(advance):
    tm = _manager()
    tm.get_token = AsyncMock(return_value="token")
    url, upload = "https://example.test/start", "https://example.test/upload"
    total = 8 * 1024 * 1024 + 17
    async with ByteSpool(0) as spool:
        await spool.append(b"x" * total)
        with aioresponses() as mock:
            mock.post(
                url + "?uploadType=resumable", headers={"Location": upload}
            )
            mock.put(
                upload,
                status=308,
                headers={"Range": "bytes=0-4194303"} if advance else {},
            )
            if advance:
                mock.put(upload, payload={"id": "done"})
                result = await google_resumable(
                    tm, "POST", url, {}, spool, "text/plain", {}
                )
                assert result == {"id": "done"}
                calls = mock.requests[("PUT", URL(upload))]
                assert [len(call.kwargs["data"]) for call in calls] == [
                    8 * 1024 * 1024,
                    total - 4 * 1024 * 1024,
                ]
                assert (
                    calls[1].kwargs["headers"]["Content-Range"]
                    == f"bytes 4194304-{total - 1}/{total}"
                )
            else:
                with pytest.raises(RuntimeError, match="no progress"):
                    await google_resumable(
                        tm, "POST", url, {}, spool, "text/plain", {}
                    )
    await tm.pool.close()


def test_a_403_waits_only_for_a_rate_limit_reason():
    assert transient(403, _reason(403, "userRateLimitExceeded"))
    assert transient(403, _reason(403, "rateLimitExceeded"))
    assert not transient(403, _reason(403, "insufficientFilePermissions"))
    assert not transient(403, _reason(403, "dailyLimitExceeded"))
    assert not transient(403, "Forbidden")
    assert not transient(403, '{"error": "denied"}')
    assert not transient(403, '{"error": {"errors": [{"reason": ["x"]}]}}')
    assert transient(429, "")
    assert transient(503, "")


async def _read(tm: TokenManager) -> dict[str, Any]:
    return await google_get(tm, FILES)


async def _read_bytes(tm: TokenManager) -> bytes:
    return await google_get_bytes(tm, FILES)


async def _read_stream(tm: TokenManager) -> bytes:
    return b"".join([chunk async for chunk in google_get_stream(tm, FILES)])


async def _create(tm: TokenManager) -> dict[str, Any]:
    return await google_post(tm, FILES, {"name": "a"})


async def _update(tm: TokenManager) -> dict[str, Any]:
    return await google_patch(tm, FILES, {"name": "a"})


async def _upload(tm: TokenManager) -> dict[str, Any]:
    return await google_send_bytes(tm, "POST", FILES, b"x", "text/plain")


async def _delete(tm: TokenManager) -> None:
    await google_delete(tm, FILES)


async def _append(tm: TokenManager) -> dict[str, Any]:
    return await append_values(tm, "s1", "A1", "[[1]]")


async def _overwrite(tm: TokenManager) -> dict[str, Any]:
    return await update_values(tm, "s1", "A1", "[[1]]")


SHEET = "https://sheets.googleapis.com/v4/spreadsheets/s1/values/A1"
READS = [
    ("GET", FILES, _read),
    ("GET", FILES, _read_bytes),
    ("GET", FILES, _read_stream),
]
WRITES = [
    ("POST", FILES, _create),
    ("PATCH", FILES, _update),
    ("POST", FILES, _upload),
    ("DELETE", FILES, _delete),
    ("POST", SHEET + ":append?valueInputOption=USER_ENTERED", _append),
    ("PUT", SHEET + "?valueInputOption=USER_ENTERED", _overwrite),
]


def _answer(mock: aioresponses, method: str, url: str, **kwargs) -> None:
    mock.add(url, method, **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url", "call"), READS)
async def test_a_read_retries_a_5xx_and_a_dropped_connection(
    method, url, call
):
    waits: list[float] = []
    tm = _signed_in(waits)
    with aioresponses() as mock:
        _answer(mock, method, url, status=503, headers={"Retry-After": "2"})
        _answer(mock, method, url, exception=aiohttp.ServerDisconnectedError())
        _answer(mock, method, url, body=b"{}")
        await call(tm)
        assert len(mock.requests[(method, URL(url))]) == 3
    assert waits == [2.0, 2.0]
    await tm.pool.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url", "call"), WRITES)
async def test_a_write_retries_a_throttle_but_never_a_5xx(method, url, call):
    waits: list[float] = []
    tm = _signed_in(waits)
    with aioresponses() as mock:
        _answer(mock, method, url, status=429, headers={"Retry-After": "0"})
        _answer(
            mock,
            method,
            url,
            status=403,
            body=_reason(403, "userRateLimitExceeded"),
            headers={"Retry-After": "0"},
        )
        _answer(mock, method, url, status=503)
        with pytest.raises(aiohttp.ClientResponseError) as raised:
            await call(tm)
        assert len(mock.requests[(method, URL(url))]) == 3
    assert raised.value.status == 503
    assert waits == [0.0, 0.0]
    await tm.pool.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url", "call"), WRITES)
async def test_a_write_never_retries_a_dropped_connection(method, url, call):
    tm = _signed_in([])
    with aioresponses() as mock:
        _answer(mock, method, url, exception=aiohttp.ServerDisconnectedError())
        with pytest.raises(aiohttp.ServerDisconnectedError):
            await call(tm)
        assert len(mock.requests[(method, URL(url))]) == 1
    await tm.pool.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "url", "call"), READS + WRITES)
async def test_a_permission_403_is_final(method, url, call):
    waits: list[float] = []
    tm = _signed_in(waits)
    with aioresponses() as mock:
        _answer(
            mock,
            method,
            url,
            status=403,
            body=_reason(403, "insufficientFilePermissions"),
        )
        with pytest.raises(aiohttp.ClientResponseError) as raised:
            await call(tm)
    assert raised.value.status == 403
    assert waits == []
    await tm.pool.close()


@pytest.mark.asyncio
async def test_a_persistent_5xx_surfaces_after_the_budget():
    waits: list[float] = []
    tm = _signed_in(waits)
    with aioresponses() as mock:
        for _ in range(MAX_RETRIES + 1):
            mock.get(FILES, status=500, body='{"error": {"message": "boom"}}')
        with pytest.raises(aiohttp.ClientResponseError) as raised:
            await google_get(tm, FILES)
        assert len(mock.requests[("GET", URL(FILES))]) == MAX_RETRIES + 1
    assert raised.value.status == 500
    assert raised.value.message == "boom"
    assert waits == [1.0, 2.0, 4.0]
    await tm.pool.close()


@pytest.mark.asyncio
async def test_a_read_timeout_is_retried():
    waits: list[float] = []
    tm = _signed_in(waits)
    with aioresponses() as mock:
        mock.get(FILES, exception=asyncio.TimeoutError())
        mock.get(FILES, payload={"files": []})
        assert await google_get(tm, FILES) == {"files": []}
    assert waits == [1.0]
    await tm.pool.close()


@pytest.mark.asyncio
async def test_the_token_exchange_retries_a_5xx():
    waits: list[float] = []

    async def _record(seconds: float) -> None:
        waits.append(seconds)

    config = GoogleConfig(client_id="cid", refresh_token="rt")
    with aioresponses() as mock:
        mock.post(TOKEN_URL, status=503, headers={"Retry-After": "3"})
        mock.post(TOKEN_URL, payload={"access_token": "t", "expires_in": 60})
        assert await refresh_access_token(config, _record) == ("t", 60)
    assert waits == [3.0]


@pytest.mark.asyncio
async def test_a_resumable_upload_retries_its_start_but_not_a_chunk():
    waits: list[float] = []
    tm = _signed_in(waits)
    url, upload = "https://example.test/start", "https://example.test/upload"
    async with ByteSpool(0) as spool:
        await spool.append(b"abc")
        with aioresponses() as mock:
            start = url + "?uploadType=resumable"
            mock.post(start, status=503, headers={"Retry-After": "1"})
            mock.post(start, headers={"Location": upload})
            mock.put(upload, status=503)
            with pytest.raises(aiohttp.ClientResponseError) as raised:
                await google_resumable(
                    tm, "POST", url, {}, spool, "text/plain", {}
                )
            assert len(mock.requests[("POST", URL(start))]) == 2
            assert len(mock.requests[("PUT", URL(upload))]) == 1
    assert raised.value.status == 503
    assert waits == [1.0]
    await tm.pool.close()


@pytest.mark.asyncio
async def test_a_dropped_write_is_sent_once():
    received: list[bytes] = []

    async def disconnect(request: web.Request) -> web.Response:
        received.append(await request.read())
        assert request.transport is not None
        request.transport.close()
        return web.Response(status=204)

    app = web.Application()
    app.router.add_put("/v4/spreadsheets/s1/values/A1", disconnect)
    async with TestServer(app) as server:
        tm = TokenManager(
            GoogleConfig(
                client_id="cid",
                refresh_token="rt",
                api_base=str(server.make_url("")).rstrip("/"),
            )
        )
        tm.get_token = AsyncMock(return_value="tok")
        with pytest.raises(aiohttp.ClientConnectionError):
            await update_values(tm, "s1", "A1", "[[1]]")
        await tm.pool.close()
    assert received == [b'{"values": [[1]]}']


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "retry"),
    [("GET", None), ("HEAD", None), ("POST", READ_RETRY)],
)
async def test_the_request_door_retries_a_read_by_method(method, retry):
    tm = _signed_in([])
    with aioresponses() as mock:
        mock.add(FILES, method, status=503)
        mock.add(FILES, method, payload={"ok": True})
        assert await google_request(tm, method, FILES, retry=retry) == {
            "ok": True
        }
        assert len(mock.requests[(method, URL(FILES))]) == 2
    await tm.pool.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["POST", "PATCH", "PUT", "DELETE"])
async def test_the_request_door_never_retries_a_write_5xx(method):
    tm = _signed_in([])
    with aioresponses() as mock:
        mock.add(FILES, method, status=503)
        mock.add(FILES, method, payload={"ok": True})
        with pytest.raises(aiohttp.ClientResponseError) as raised:
            await google_request(tm, method, FILES)
        assert len(mock.requests[(method, URL(FILES))]) == 1
    assert raised.value.status == 503
    await tm.pool.close()
