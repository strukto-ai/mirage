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
from enum import Enum
from typing import TYPE_CHECKING

from fastapi import HTTPException
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header

if TYPE_CHECKING:
    from python_multipart.multipart import MultipartCallbacks

MAX_REQUEST_PART = 1024 * 1024
MAX_SNAPSHOT_PART = 1024 * 1024 * 1024
MAX_HEADER_COUNT = 8
MAX_HEADER_SIZE = 4096 + 128


class PartEvent(Enum):
    BEGIN = "begin"
    DATA = "data"
    END = "end"


class Parts:
    """python-multipart's callbacks as a queue of part events.

    The parser calls back synchronously, so the events wait here and
    the reader acts on them, awaiting as it goes, after each chunk.
    """

    def __init__(self) -> None:
        self._events: list[tuple[PartEvent, bytes]] = []
        self._headers: dict[bytes, bytes] = {}
        self._field = b""
        self._value = b""
        self.finished = False

    def callbacks(self) -> "MultipartCallbacks":
        return {
            "on_part_begin": self._begin,
            "on_header_field": self._header_field,
            "on_header_value": self._header_value,
            "on_header_end": self._header_end,
            "on_headers_finished": self._headers_finished,
            "on_part_data": self._data,
            "on_part_end": self._end,
            "on_end": self._finish,
        }

    def take(self) -> list[tuple[PartEvent, bytes]]:
        events, self._events = self._events, []
        return events

    def _begin(self) -> None:
        self._headers = {}

    def _header_field(self, data: bytes, start: int, end: int) -> None:
        self._field += data[start:end]

    def _header_value(self, data: bytes, start: int, end: int) -> None:
        self._value += data[start:end]

    def _header_end(self) -> None:
        self._headers[self._field.lower()] = self._value
        self._field = b""
        self._value = b""

    def _headers_finished(self) -> None:
        _, options = parse_options_header(
            self._headers.get(b"content-disposition", b"")
        )
        self._events.append((PartEvent.BEGIN, options.get(b"name", b"")))

    def _data(self, data: bytes, start: int, end: int) -> None:
        self._events.append((PartEvent.DATA, data[start:end]))

    def _end(self) -> None:
        self._events.append((PartEvent.END, b""))

    def _finish(self) -> None:
        self.finished = True


async def part_events(
    chunks: AsyncIterator[bytes], content_type: str
) -> AsyncIterator[tuple[PartEvent, bytes]]:
    """A multipart body's part events, as the body arrives.

    A part begins once its headers end, before any of its data, and its
    data goes out chunk by chunk, so a reader can act on a part while
    it is still uploading.

    Args:
        chunks (AsyncIterator[bytes]): the request body.
        content_type (str): its ``Content-Type`` header.

    Yields:
        tuple[PartEvent, bytes]: ``BEGIN`` with the part's name, ``DATA``
            with a chunk of it, ``END``.

    Raises:
        HTTPException: 400 for a body without a boundary, a malformed
            one, or one that stops before its closing boundary.
    """
    _, options = parse_options_header(content_type)
    boundary = options.get(b"boundary")
    if not boundary:
        raise HTTPException(
            status_code=400, detail="multipart body without a boundary"
        )
    parts = Parts()
    parser = MultipartParser(
        boundary,
        parts.callbacks(),
        max_header_count=MAX_HEADER_COUNT,
        max_header_size=MAX_HEADER_SIZE,
    )
    async for chunk in chunks:
        try:
            parser.write(chunk)
        except MultipartParseError as e:
            raise HTTPException(
                status_code=400, detail=f"bad multipart body: {e}"
            )
        for event in parts.take():
            yield event
    parser.finalize()
    if not parts.finished:
        raise HTTPException(
            status_code=400, detail="multipart body ended early"
        )
