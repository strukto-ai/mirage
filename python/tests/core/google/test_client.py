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
from unittest.mock import AsyncMock, patch

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.core.google.client import (
    TokenManager,
    calendar_base,
    docs_base,
    drive_base,
    drive_upload_base,
    forms_base,
    gmail_base,
    google_error_message,
    google_get_stream,
    google_headers,
    google_resumable,
    sheets_base,
    slides_base,
    token_url,
)
from mirage.core.google.config import GoogleConfig
from mirage.core.google.constants import (
    CALENDAR_API_BASE,
    DOCS_API_BASE,
    DRIVE_API_BASE,
    DRIVE_UPLOAD_BASE,
    FORMS_API_BASE,
    GMAIL_API_BASE,
    SHEETS_API_BASE,
    SLIDES_API_BASE,
    TOKEN_URL,
)
from mirage.io.spool import ByteSpool

API_ERROR = (
    '{"error": {"code": 400, "message": "Unsupported request: '
    'insertDimension", "status": "INVALID_ARGUMENT"}}'
)
TOKEN_ERROR = (
    '{"error": "invalid_grant", "error_description": '
    '"Token has been expired or revoked."}'
)


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
    refresh.assert_called_once_with(mgr.config)


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
