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
from collections.abc import AsyncGenerator, Mapping
from contextlib import aclosing

from mirage_rs import Stream, StreamError

from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource
from mirage.rs.errors import StreamRefusal
from mirage.types import JsonValue


class OpenStream:
    """One mirage-rs stream: chunks go in, the bytes they produce come out.

    Args:
        kind (str): The stream to open, e.g. ``"base64"``.
        config (Mapping[str, JsonValue]): Its configuration.
    """

    def __init__(self, kind: str, config: Mapping[str, JsonValue]) -> None:
        try:
            self._stream = Stream(kind, json.dumps(config).encode())
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), b"") from exc

    def feed(self, chunk: bytes) -> bytes:
        """Push one chunk.

        Args:
            chunk (bytes): The next bytes of input.
        """
        try:
            return self._stream.feed(chunk)
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), bytes(exc.args[1])) from exc

    def finish(self) -> bytes:
        """End the input and return what the stream held back."""
        try:
            return self._stream.finish()
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), bytes(exc.args[1])) from exc

    def busy(self) -> bool:
        """Whether ``drain`` has work or output left."""
        return self._stream.busy()

    def drain(self) -> bytes:
        """One bounded step of the work ``busy`` reports, and its output."""
        try:
            return self._stream.drain()
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), bytes(exc.args[1])) from exc

    def wants(self) -> int | None:
        """The input a multi-input stream needs next, None for none."""
        return self._stream.wants()

    def feed_input(self, index: int, chunk: bytes) -> bytes:
        """Push one chunk of input *index* to a multi-input stream.

        Args:
            index (int): The input, from 0.
            chunk (bytes): Its next bytes.
        """
        try:
            return self._stream.feed_input(index, chunk)
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), bytes(exc.args[1])) from exc

    def end_input(self, index: int) -> bytes:
        """End input *index* of a multi-input stream.

        Args:
            index (int): The input, from 0.
        """
        try:
            return self._stream.end_input(index)
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), bytes(exc.args[1])) from exc


def open_stream(kind: str, config: Mapping[str, JsonValue]) -> OpenStream:
    """Open the mirage-rs stream *kind*.

    Args:
        kind (str): The stream to open.
        config (Mapping[str, JsonValue]): Its configuration.
    """
    return OpenStream(kind, config)


async def run_stream(
    kind: str, config: Mapping[str, JsonValue], source: ByteSource
) -> AsyncGenerator[bytes, None]:
    """Stream *source* through *kind*, one bounded chunk at a time.

    A refusal raises ``StreamRefusal`` holding the output written before
    it, so the caller records the failure before it passes that output on:
    a reader that stops at the output would otherwise never see it.

    Args:
        kind (str): The stream to open.
        config (Mapping[str, JsonValue]): Its configuration.
        source (ByteSource): The input bytes.
    """
    stream = open_stream(kind, config)
    async with aclosing(chunks(source)) as bounded:
        async for chunk in bounded:
            if output := stream.feed(chunk):
                yield output
    if output := stream.finish():
        yield output
