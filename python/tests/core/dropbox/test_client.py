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

import json
from collections.abc import Callable, Mapping
from unittest.mock import AsyncMock, patch

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.core.dropbox.client import (
    DropboxTokenManager,
    _token_url,
    dropbox_download,
    dropbox_download_stream,
    summary_of,
)
from mirage.core.dropbox.constants import (
    DROPBOX_API_BASE,
    DROPBOX_CONTENT_BASE,
)
from mirage.utils.ranges import ByteWindow
from mirage.vfs.dropbox.config import DropboxConfig


def make_config(**overrides) -> DropboxConfig:
    return DropboxConfig(
        client_id="c", client_secret="s", refresh_token="r", **overrides
    )


def test_default_bases_are_production_hosts():
    tm = DropboxTokenManager(make_config())
    assert tm.api_base == DROPBOX_API_BASE
    assert tm.content_base == DROPBOX_CONTENT_BASE


def test_endpoint_override_serves_api_and_content_from_one_origin():
    tm = DropboxTokenManager(make_config(endpoint="http://127.0.0.1:9999/"))
    assert tm.api_base == "http://127.0.0.1:9999/2"
    assert tm.content_base == "http://127.0.0.1:9999/2"
    assert (
        _token_url(make_config(endpoint="http://127.0.0.1:9999/"))
        == "http://127.0.0.1:9999/oauth2/token"
    )


def test_token_url_defaults_to_production():
    assert (
        _token_url(make_config()) == "https://api.dropboxapi.com/oauth2/token"
    )


@pytest.mark.asyncio
async def test_get_token_caches_until_expiry():
    tm = DropboxTokenManager(make_config())
    with patch(
        "mirage.core.dropbox.client.refresh_access_token",
        new_callable=AsyncMock,
        return_value=("tok", 14400),
    ) as refresh:
        assert await tm.get_token() == "tok"
        assert await tm.get_token() == "tok"
    assert refresh.await_count == 1


DOWNLOAD_URL = f"{DROPBOX_CONTENT_BASE}/files/download"


async def _download(
    status: int,
    body: bytes,
    window: ByteWindow | None,
    headers: dict[str, str] | None = None,
    path: str = "/a.txt",
) -> tuple[bytes, str | None, dict]:
    tm = DropboxTokenManager(make_config())
    with patch(
        "mirage.core.dropbox.client.dropbox_auth_headers",
        new_callable=AsyncMock,
        return_value={},
    ):
        with aioresponses() as m:
            m.post(DOWNLOAD_URL, status=status, body=body, headers=headers)
            data, result = await dropbox_download(tm, path, window)
            sent = m.requests[("POST", URL(DOWNLOAD_URL))][0].kwargs
    return data, result, sent


RESULT = json.dumps({"name": "a.txt", "content_hash": "abc123"})


@pytest.mark.asyncio
async def test_a_window_is_sent_as_a_range_header():
    _, _, sent = await _download(206, b"234", ByteWindow(2, 3))

    assert sent["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_a_206_body_is_trusted_as_the_window():
    data, _, _ = await _download(206, b"234", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_a_200_is_sliced_because_the_server_ignored_the_range():
    """RFC 9110 lets a server answer a Range request with the whole
    representation. Before this was handled the caller got every byte for
    what it asked to be a window."""
    data, _, _ = await _download(200, b"0123456789", ByteWindow(2, 3))

    assert data == b"234"


@pytest.mark.asyncio
async def test_the_arg_header_escapes_the_path_from_del_up():
    # A header is a ByteString. From DEL (U+007F) up, every UTF-16 unit
    # goes as \uXXXX, an astral character as its two surrogates; "~"
    # (U+007E) is the last character sent raw. TypeScript's headerJson
    # escapes the same characters.
    path = "/~\x7f\u00e9\u4e2d\U0001f600"
    _, _, sent = await _download(200, b"", None, path=path)

    assert sent["headers"]["Dropbox-API-Arg"] == (
        r'{"path": "/~\u007f\u00e9\u4e2d\ud83d\ude00"}'
    )


@pytest.mark.asyncio
async def test_no_window_sends_no_header_and_reads_whole():
    data, _, sent = await _download(200, b"0123456789", None)

    assert data == b"0123456789"
    assert "Range" not in sent["headers"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status, window",
    [(200, None), (206, ByteWindow(2, 3))],
    ids=["whole", "ranged"],
)
async def test_a_download_hands_back_its_result_header(status, window):
    # A ranged (206) download names the file's metadata too, so a windowed
    # read stamps the same token a whole one does.
    _, result, _ = await _download(
        status, b"234", window, {"Dropbox-API-Result": RESULT}
    )

    assert result == RESULT


@pytest.mark.asyncio
async def test_a_download_without_a_result_header_hands_back_none():
    _, result, _ = await _download(200, b"x", None)

    assert result is None


async def _stream(
    on_response: Callable[[Mapping[str, str]], None],
    events: list[str | None],
) -> None:
    tm = DropboxTokenManager(make_config())
    with patch(
        "mirage.core.dropbox.client.dropbox_auth_headers",
        new_callable=AsyncMock,
        return_value={},
    ):
        with aioresponses() as m:
            m.post(
                DOWNLOAD_URL,
                status=200,
                body=b"hello",
                headers={"Dropbox-API-Result": RESULT},
            )
            async for chunk in dropbox_download_stream(
                tm, "/a.txt", on_response=on_response
            ):
                events.append(chunk.decode())
        await tm.pool.close()


@pytest.mark.asyncio
async def test_a_stream_hands_its_result_header_before_the_first_chunk():
    # A consumer that stops early still leaves the read stamped.
    events: list[str | None] = []
    await _stream(lambda h: events.append(h.get("dropbox-api-result")), events)
    assert events == [RESULT, "hello"]


@pytest.mark.asyncio
async def test_a_stream_hands_a_plain_lower_cased_map():
    # As bytes_response hands its own: a caller's dict lookup must not
    # lean on aiohttp's case-insensitivity.
    handed: list[Mapping[str, str]] = []
    await _stream(handed.append, [])
    assert type(handed[0]) is dict
    assert "dropbox-api-result" in handed[0]


@pytest.mark.parametrize(
    "text",
    [
        "null",
        '{"error_summary": null}',
        '{"error_summary": 5}',
        '["path/not_found/.."]',
        "oops",
    ],
    ids=[
        "null-body",
        "null-summary",
        "number-summary",
        "not-object",
        "not-json",
    ],
)
def test_a_body_without_a_string_summary_is_empty(text):
    # A 409 body without a string error_summary is no verdict: the summary
    # is "", so no caller reads it as a miss or trips on a non-string.
    assert summary_of(text) == ""
