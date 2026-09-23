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

from unittest.mock import AsyncMock, patch

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.core.dropbox.client import (DropboxTokenManager, _token_url,
                                        dropbox_download)
from mirage.core.dropbox.constants import (DROPBOX_API_BASE,
                                           DROPBOX_CONTENT_BASE)
from mirage.utils.ranges import ByteWindow
from mirage.vfs.dropbox.config import DropboxConfig


def make_config(**overrides) -> DropboxConfig:
    return DropboxConfig(client_id="c",
                         client_secret="s",
                         refresh_token="r",
                         **overrides)


def test_default_bases_are_production_hosts():
    tm = DropboxTokenManager(make_config())
    assert tm.api_base == DROPBOX_API_BASE
    assert tm.content_base == DROPBOX_CONTENT_BASE


def test_endpoint_override_serves_api_and_content_from_one_origin():
    tm = DropboxTokenManager(make_config(endpoint="http://127.0.0.1:9999/"))
    assert tm.api_base == "http://127.0.0.1:9999/2"
    assert tm.content_base == "http://127.0.0.1:9999/2"
    assert _token_url(make_config(endpoint="http://127.0.0.1:9999/")) == \
        "http://127.0.0.1:9999/oauth2/token"


def test_token_url_defaults_to_production():
    assert _token_url(
        make_config()) == "https://api.dropboxapi.com/oauth2/token"


@pytest.mark.asyncio
async def test_get_token_caches_until_expiry():
    tm = DropboxTokenManager(make_config())
    with patch("mirage.core.dropbox.client.refresh_access_token",
               new_callable=AsyncMock,
               return_value=("tok", 14400)) as refresh:
        assert await tm.get_token() == "tok"
        assert await tm.get_token() == "tok"
    assert refresh.await_count == 1


DOWNLOAD_URL = f"{DROPBOX_CONTENT_BASE}/files/download"


async def _download(status: int, body: bytes,
                    window: ByteWindow | None) -> tuple[bytes, dict]:
    tm = DropboxTokenManager(make_config())
    with patch("mirage.core.dropbox.client.dropbox_auth_headers",
               new_callable=AsyncMock,
               return_value={}):
        with aioresponses() as m:
            m.post(DOWNLOAD_URL, status=status, body=body)
            data = await dropbox_download(tm, "/a.txt", window)
            sent = m.requests[("POST", URL(DOWNLOAD_URL))][0].kwargs
    return data, sent


@pytest.mark.asyncio
async def test_a_window_is_sent_as_a_range_header():
    _, sent = await _download(206, b"234", ByteWindow(2, 3))

    assert sent["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_a_206_body_is_trusted_as_the_window():
    data, _ = await _download(206, b"234", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_a_200_is_sliced_because_the_server_ignored_the_range():
    """RFC 9110 lets a server answer a Range request with the whole
    representation. Before this was handled the caller got every byte for
    what it asked to be a window."""
    data, _ = await _download(200, b"0123456789", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_no_window_sends_no_header_and_reads_whole():
    data, sent = await _download(200, b"0123456789", None)

    assert data == b"0123456789"
    assert "Range" not in sent["headers"]
