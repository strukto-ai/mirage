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
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from contextlib import aclosing
from typing import NamedTuple, Protocol

from mirage._rs import Stream, StreamError
from mirage.io.cooperative import chunks
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource
from mirage.io.yield_budget import YieldBudget
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

    def cancel(self) -> bool:
        """Stop processing and report whether bounded retirement is available."""
        return self._stream.cancel()

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

    def begin(self, config: Mapping[str, JsonValue]) -> None:
        """Start the next input of a stream that reads one after another.

        Args:
            config (Mapping[str, JsonValue]): That input's configuration.
        """
        try:
            self._stream.begin(json.dumps(config).encode())
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), b"") from exc

    def done(self) -> bool:
        """Whether the stream wants no more of the current input."""
        return self._stream.done()

    def status(self) -> int:
        """The command's exit status for the input so far."""
        return self._stream.status()

    def metadata(self) -> bytes:
        """The stream's current progress as its typed JSON record."""
        return self._stream.metadata()

    def take_stderr(self) -> bytes:
        """What the stream wrote to stderr since the last call."""
        return self._stream.take_stderr()

    def request(self) -> tuple[dict[str, JsonValue], bytes] | None:
        """The host operation the stream waits on and the bytes it
        carries, or None while it waits on none."""
        taken = self._stream.request()
        if taken is None:
            return None
        header, data = taken
        return json.loads(header), data

    def respond(self, reply: Mapping[str, JsonValue], data: bytes) -> bytes:
        """Answer the request taken last.

        Args:
            reply (Mapping[str, JsonValue]): The host's answer.
            data (bytes): The bytes it carries.
        """
        try:
            return self._stream.respond(json.dumps(reply).encode(), data)
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), bytes(exc.args[1])) from exc


class Served(NamedTuple):
    """What a host made of one request.

    Args:
        reply (dict[str, JsonValue]): The answer the stream reads.
        data (bytes): The bytes the answer carries.
        output (ByteSource | None): What the host wrote to the output
            doing it, which goes out before the stream's next output.
    """

    reply: dict[str, JsonValue]
    data: bytes = b""
    output: ByteSource | None = None


class RequestHost(Protocol):
    """Serves the requests of a stream that reaches files and commands;
    ``errors`` gathers its stderr and theirs, in order."""

    @property
    def errors(self) -> ByteSpool: ...

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Do one request.

        Args:
            request (Mapping[str, JsonValue]): What the stream asks.
            data (bytes): The bytes it carries.
        """
        ...


async def serve_requests(
    stream: OpenStream, host: RequestHost
) -> AsyncGenerator[bytes, None]:
    """Run a stream until it waits on neither work nor its host, a bounded
    call at a time, serving each request it makes.

    Args:
        stream (OpenStream): The command engine.
        host (RequestHost): Serves its requests.
    """
    budget = YieldBudget()
    while True:
        while stream.busy():
            await budget.run()
            output = stream.drain()
            await host.errors.append(stream.take_stderr())
            if output:
                yield output
        taken = stream.request()
        if taken is None:
            break
        await budget.run()
        served = await host.serve(*taken)
        if served.output is not None:
            async with aclosing(chunks(served.output)) as pulled:
                async for chunk in pulled:
                    yield chunk
        if output := stream.respond(served.reply, served.data):
            yield output
    if output := stream.finish():
        yield output
    await host.errors.append(stream.take_stderr())


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
    async with aclosing(stream_output_chunks(stream, source)) as output:
        async for chunk in output:
            yield chunk


async def merge_output(
    stream: OpenStream, read: Callable[[int], Awaitable[bytes | None]]
) -> AsyncGenerator[bytes, None]:
    """Feed a multi-input stream the input its ``wants`` names until it
    wants none, handing on its output a bounded call at a time.

    Args:
        stream (OpenStream): The command engine.
        read (Callable[[int], Awaitable[bytes | None]]): An input's next
            chunk, None at its end.
    """
    budget = YieldBudget()
    while True:
        while stream.busy():
            await budget.run()
            if output := stream.drain():
                yield output
        index = stream.wants()
        if index is None:
            break
        await budget.run()
        chunk = await read(index)
        output = (
            stream.end_input(index)
            if chunk is None
            else stream.feed_input(index, bytes(chunk))
        )
        if output:
            yield output
    if output := stream.finish():
        yield output


async def stream_output_chunks(
    stream: OpenStream, source: ByteSource
) -> AsyncGenerator[bytes, None]:
    budget = YieldBudget()
    try:
        async with aclosing(chunks(source)) as bounded:
            async for chunk in bounded:
                if output := stream.feed(chunk):
                    yield output
                while stream.busy():
                    await budget.run()
                    if output := stream.drain():
                        yield output
        if output := stream.finish():
            yield output
        while stream.busy():
            await budget.run()
            if output := stream.drain():
                yield output
    finally:
        await close_stream(stream)


async def close_stream(stream: OpenStream) -> None:
    """Retire cancelled records through bounded calls before native release.

    Args:
        stream (OpenStream): The owned command engine.
    """
    if stream.cancel():
        budget = YieldBudget()
        while stream.busy():
            await budget.run()
            stream.drain()
