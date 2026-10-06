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

from collections.abc import AsyncIterator

import pytest
from fastapi import HTTPException

from mirage.server.multipart import PartEvent, part_events

BOUNDARY = "b0undary"
CONTENT_TYPE = f"multipart/form-data; boundary={BOUNDARY}"
HEAD = (
    f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="stdin"\r\n\r\n'
).encode()
END = f"\r\n--{BOUNDARY}--\r\n".encode()


async def _chunks(*chunks: bytes) -> AsyncIterator[bytes]:
    for chunk in chunks:
        yield chunk


async def _events(*chunks: bytes) -> list[tuple[PartEvent, bytes]]:
    return [e async for e in part_events(_chunks(*chunks), CONTENT_TYPE)]


@pytest.mark.asyncio
async def test_a_part_begins_before_its_first_byte():
    events = part_events(_chunks(HEAD, b"ab", END), CONTENT_TYPE)
    assert await anext(events) == (PartEvent.BEGIN, b"stdin")
    rest = [e async for e in events]
    data = b"".join(d for e, d in rest if e is PartEvent.DATA)
    assert (data, rest[-1]) == (b"ab", (PartEvent.END, b""))


@pytest.mark.asyncio
async def test_data_survives_any_split():
    body = HEAD + f"a\r\n--{BOUNDARY[:-1]}\r".encode() + END
    events = await _events(*(body[i : i + 3] for i in range(0, len(body), 3)))
    data = b"".join(d for e, d in events if e is PartEvent.DATA)
    assert data == f"a\r\n--{BOUNDARY[:-1]}\r".encode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stdin",
    [
        f"a\r\n--{BOUNDARY}world".encode(),
        f"a\r\n--{BOUNDARY}-x".encode(),
        f"a\r\n--{BOUNDARY}\rx".encode(),
    ],
)
async def test_a_boundary_not_followed_by_dashes_or_a_line_break_is_data(
    stdin,
):
    body = HEAD + stdin + END
    for chunks in ((body,), tuple(body[i : i + 1] for i in range(len(body)))):
        events = await _events(*chunks)
        data = b"".join(d for e, d in events if e is PartEvent.DATA)
        assert data == stdin


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("chunks", "content_type", "detail"),
    [
        ((HEAD,), "multipart/form-data", "multipart body without a boundary"),
        ((HEAD, b"ab"), CONTENT_TYPE, "multipart body ended early"),
        (
            (
                f"--{BOUNDARY}\r\nX-Pad: {'x' * 5000}\r\n\r\n".encode(),
                END,
            ),
            CONTENT_TYPE,
            "bad multipart body: Maximum header size exceeded",
        ),
    ],
)
async def test_a_bad_body_is_refused(chunks, content_type, detail):
    with pytest.raises(HTTPException) as caught:
        [e async for e in part_events(_chunks(*chunks), content_type)]
    assert (caught.value.status_code, caught.value.detail) == (400, detail)
