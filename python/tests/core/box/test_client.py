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

from mirage.core.box.client import (
    BoxTokenManager,
    api_base_of,
    box_get_bytes,
    conflict_of,
    token_url_of,
    upload_base_of,
)
from mirage.core.box.constants import (
    BOX_API_BASE,
    BOX_TOKEN_URL,
    BOX_UPLOAD_BASE,
)
from mirage.utils.ranges import ByteWindow
from mirage.vfs.box.config import BoxConfig


def test_urls_default_to_real_box():
    config = BoxConfig(access_token="tok")
    assert token_url_of(config) == BOX_TOKEN_URL
    assert api_base_of(config) == BOX_API_BASE
    assert upload_base_of(config) == BOX_UPLOAD_BASE
    assert BOX_UPLOAD_BASE == "https://upload.box.com/api/2.0"


def test_urls_derive_from_endpoint_override():
    config = BoxConfig(access_token="tok", endpoint="http://127.0.0.1:5096/")
    assert token_url_of(config) == "http://127.0.0.1:5096/oauth2/token"
    assert api_base_of(config) == "http://127.0.0.1:5096/2.0"
    assert upload_base_of(config) == "http://127.0.0.1:5096/2.0"


def test_token_manager_requires_some_credentials():
    with pytest.raises(ValueError, match="provide access_token"):
        BoxTokenManager(BoxConfig())


def test_token_manager_ccg_requires_client_secret():
    with pytest.raises(ValueError, match="client_secret is required"):
        BoxTokenManager(BoxConfig(client_id="cid", enterprise_id="eid"))


def test_token_manager_refresh_requires_client_id():
    with pytest.raises(ValueError, match="client_id is required"):
        BoxTokenManager(BoxConfig(refresh_token="rt"))


@pytest.mark.asyncio
async def test_dev_token_mode_returns_token_without_refresh():
    tm = BoxTokenManager(BoxConfig(access_token="dev-token"))
    assert await tm.get_token() == "dev-token"


@pytest.mark.asyncio
async def test_refresh_mode_rotates_refresh_token():
    rotated: list[str] = []

    async def on_rotated(token: str) -> None:
        rotated.append(token)

    config = BoxConfig(
        client_id="cid",
        refresh_token="rt-1",
        on_refresh_token_rotated=on_rotated,
    )
    tm = BoxTokenManager(config)
    with patch(
        "mirage.core.box.client.refresh_access_token",
        new_callable=AsyncMock,
        return_value=("at-1", "rt-2", 3600),
    ) as mock_refresh:
        assert await tm.get_token() == "at-1"
        # Cached until expiry: no second HTTP call.
        assert await tm.get_token() == "at-1"
        mock_refresh.assert_awaited_once_with(config, "rt-1")
    assert rotated == ["rt-2"]


@pytest.mark.asyncio
async def test_refresh_fn_overrides_default_flow():
    async def refresh_fn(current: str) -> tuple[str, str, int]:
        assert current == "rt-1"
        return "at-custom", "rt-1", 3600

    tm = BoxTokenManager(
        BoxConfig(client_id="cid", refresh_token="rt-1", refresh_fn=refresh_fn)
    )
    assert await tm.get_token() == "at-custom"


@pytest.mark.asyncio
async def test_ccg_mode_refetches_via_client_credentials():
    config = BoxConfig(
        client_id="cid", client_secret="cs", enterprise_id="eid"
    )
    tm = BoxTokenManager(config)
    with patch(
        "mirage.core.box.client.fetch_ccg_token",
        new_callable=AsyncMock,
        return_value=("at-ccg", 3600),
    ) as mock_ccg:
        assert await tm.get_token() == "at-ccg"
        mock_ccg.assert_awaited_once_with(config)


GET_URL = "https://api.example/x"


async def _get_bytes(
    status: int, body: bytes, window: ByteWindow | None
) -> tuple[bytes, dict]:
    tm = BoxTokenManager(BoxConfig(access_token="tok"))
    with aioresponses() as m:
        m.get(GET_URL, status=status, body=body)
        data = await box_get_bytes(tm, GET_URL, window=window)
        sent = m.requests[("GET", URL(GET_URL))][0].kwargs
    return data, sent


@pytest.mark.asyncio
async def test_a_window_is_sent_as_a_range_header():
    _, sent = await _get_bytes(206, b"234", ByteWindow(2, 3))

    assert sent["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_a_206_body_is_trusted_as_the_window():
    data, _ = await _get_bytes(206, b"234", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_a_200_is_sliced_because_the_server_ignored_the_range():
    """Box redirects content downloads to a CDN, which may answer the
    whole object to a Range request. Before this was handled the caller
    got every byte for what it asked to be a window."""
    data, _ = await _get_bytes(200, b"0123456789", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_no_window_sends_no_header_and_reads_whole():
    data, sent = await _get_bytes(200, b"0123456789", None)

    assert data == b"0123456789"
    assert "Range" not in sent["headers"]


@pytest.mark.parametrize(
    "text, kind",
    [
        (
            '{"code": "item_name_in_use", '
            '"context_info": {"conflicts": [{"type": "folder"}]}}',
            "folder",
        ),
        ('{"context_info": {"conflicts": {"type": "file"}}}', "file"),
        ('{"context_info": {"conflicts": []}}', None),
        ("<html>502 Bad Gateway</html>", None),
        ('{"a":' * 100000, None),
    ],
    ids=["list", "object", "empty", "html", "deep"],
)
def test_conflict_of_reads_the_item_a_409_names(text, kind):
    assert conflict_of(text) == kind
