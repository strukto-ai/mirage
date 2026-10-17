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
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.files import download_file, file_blob_name

BODY = b"0123456789"
CDN_URL = "https://cdn.example/a.csv"


async def _download(
    status: int, body: bytes, offset: int, size: int | None
) -> tuple[bytes, dict]:
    with aioresponses() as m:
        m.get(CDN_URL, status=status, body=body)
        async with DiscordAccessor(DiscordConfig(token="t")) as accessor:
            data = await download_file(accessor, CDN_URL, offset, size)
        sent = m.requests[("GET", URL(CDN_URL))][0].kwargs
    return data, sent


@pytest.mark.asyncio
async def test_the_window_is_sent_as_a_range_header():
    _, sent = await _download(206, b"234", 2, 3)

    assert sent["headers"]["Range"] == "bytes=2-4"


@pytest.mark.asyncio
async def test_a_206_body_is_trusted_as_the_window():
    data, _ = await _download(206, b"234", 2, 3)

    assert data == b"234"


@pytest.mark.asyncio
async def test_a_200_is_sliced_because_the_cdn_ignored_the_range():
    """A CDN may legally answer 200 with the whole file to a Range
    request. Before this was handled the caller got every byte for what
    it asked to be a window."""
    data, _ = await _download(200, BODY, 2, 3)

    assert data == b"234"


@pytest.mark.asyncio
async def test_no_window_sends_no_header_and_reads_whole():
    data, sent = await _download(200, BODY, 0, None)

    assert data == BODY
    assert "Range" not in (sent["headers"] or {})


@pytest.mark.parametrize(
    "att,expected",
    [
        (
            {"id": "A1", "filename": "budget.csv", "title": "Q4"},
            "budget__A1.csv",
        ),
        ({"id": "A2", "filename": "", "title": "scan.png"}, "scan__A2.png"),
        ({"id": "A3"}, "file__A3"),
    ],
)
def test_file_blob_name(att, expected):
    assert file_blob_name(att) == expected
