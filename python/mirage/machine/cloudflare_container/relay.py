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
import json
import logging
from collections.abc import Callable, Coroutine, Iterable
from typing import SupportsIndex

import aiohttp

from mirage.machine.cloudflare_container.constants import (
    RELAY_EXEC,
    RELAY_MONITOR,
    RELAY_START,
    RELAY_WINDOW_BYTES,
    STDERR_CHANNEL,
    STDOUT_CHANNEL,
)
from mirage.machine.cloudflare_container.types import (
    ExecProcess,
    RelayControl,
    RelayEvent,
    RelayRequest,
)

logger = logging.getLogger(__name__)

CLOSED = "the connection to the relay closed"


def frame_of(data: str) -> RelayEvent | None:
    """The object a text frame carries, or None for a frame that is not
    one.

    Args:
        data (str): the frame's text.
    """
    try:
        frame = json.loads(data)
    except ValueError as exc:
        logger.debug("cloudflare_container: a frame that is not one: %s", exc)
        return None
    return frame if isinstance(frame, dict) else None


def bytes_of(message: aiohttp.WSMessage) -> bytes | None:
    """The bytes of a binary frame; None for any other.

    Args:
        message (aiohttp.WSMessage): what the socket received.
    """
    if message.type is aiohttp.WSMsgType.BINARY:
        return bytes(message.data)
    return None


class Channel(asyncio.StreamReader):
    """One output stream of a relayed process, fed from its socket. Each
    ``read`` and ``readexactly``, the two calls its readers make, tells
    the relay how many bytes it took, a window's worth at most at a time,
    and the relay sends no more than ``RELAY_WINDOW_BYTES`` ahead of that.
    A stream ``discard`` let go takes everything still coming, so the
    program writing it never waits on a reader that has gone.

    Args:
        took (Callable[[int], None]): told how many bytes a read took.
    """

    def __init__(self, took: Callable[[int], None]) -> None:
        super().__init__()
        self._took = took
        self._unread = 0
        self.discarding = False

    def feed_data(self, data: Iterable[SupportsIndex]) -> None:
        chunk = bytes(data)
        if self.discarding:
            self._took(len(chunk))
            return
        self._unread += len(chunk)
        super().feed_data(chunk)

    def discard(self) -> None:
        """Let the stream go: what it holds and what comes later count
        as taken."""
        self.discarding = True
        if self._unread:
            self._took(self._unread)
            self._unread = 0

    def _ack(self, data: bytes) -> bytes:
        if data and not self.discarding:
            self._unread -= len(data)
            self._took(len(data))
        return data

    async def read(self, n: int = -1) -> bytes:
        return self._ack(await super().read(n))

    async def readexactly(self, n: int) -> bytes:
        parts: list[bytes] = []
        left = n
        while left:
            chunk = await super().read(min(left, RELAY_WINDOW_BYTES))
            if not chunk:
                raise asyncio.IncompleteReadError(b"".join(parts), n)
            parts.append(self._ack(chunk))
            left -= len(chunk)
        return b"".join(parts)


class RelayInput:
    """A relayed process's stdin: each write a binary frame, its end an
    ``eof``. A write waits while more than ``RELAY_WINDOW_BYTES`` sent
    are not yet taken by the program.

    Args:
        process (RelayProcess): the process the input belongs to.
    """

    def __init__(self, process: "RelayProcess") -> None:
        self._process = process

    async def write(self, data: bytes) -> None:
        self._process.refuse_closed_input()
        await self._process.send(bytes(data))
        await self._process.room()
        self._process.refuse_closed_input()

    async def close(self) -> None:
        if not self._process.input_closed:
            await self._process.control({"eof": True})


class RelayProcess:
    """A process a relay runs: its stdin sent as binary frames, its
    output fed from the frames that come back. The socket closes once the
    process has exited and both its output streams are done or released;
    one that closes sooner fails what is still open, as a lost
    connection.

    Args:
        socket (aiohttp.ClientWebSocketResponse): the exec's socket.
    """

    def __init__(self, socket: aiohttp.ClientWebSocketResponse) -> None:
        self._socket = socket
        self._stdout = Channel(lambda n: self._took(STDOUT_CHANNEL, n))
        self._stderr = Channel(lambda n: self._took(STDERR_CHANNEL, n))
        self._exit_code: asyncio.Future[int] = (
            asyncio.get_running_loop().create_future()
        )
        self._stdin = RelayInput(self)
        self._done = {STDOUT_CHANNEL: False, STDERR_CHANNEL: False}
        self._closed = False
        self._tasks: set[asyncio.Task[None]] = set()
        # Bytes of stdin sent that the program has not taken, and whether
        # the relay said the program closed its input.
        self._untaken = 0
        self.input_closed = False
        self._free = asyncio.Event()

    @property
    def stdin(self) -> RelayInput:
        return self._stdin

    @property
    def stdout(self) -> Channel:
        return self._stdout

    @property
    def stderr(self) -> Channel:
        return self._stderr

    @property
    def exit_code(self) -> asyncio.Future[int]:
        return self._exit_code

    async def kill(self, signum: int = 15) -> None:
        if not self._closed:
            await self.control({"kill": signum})

    def release(self) -> None:
        for channel in self._done:
            self._reader(channel).discard()
            self._end(channel)

    def read(self) -> None:
        """Feed the process from its socket until the socket closes."""
        self._spawn(self._read())

    async def send(self, data: bytes) -> None:
        if self._closed:
            raise ConnectionResetError(CLOSED)
        await self._socket.send_bytes(data)
        self._untaken += len(data)

    def refuse_closed_input(self) -> None:
        """Fail a write once the program has closed its input, as a
        closed pipe would."""
        if self.input_closed:
            raise BrokenPipeError("the program closed its input")

    async def room(self) -> None:
        """Wait until the program has taken enough stdin for more."""
        while (
            not self._closed
            and not self.input_closed
            and self._untaken > RELAY_WINDOW_BYTES
        ):
            self._free.clear()
            await self._free.wait()

    def _took(self, channel: int, n: int) -> None:
        if n and not self._closed:
            self._spawn(self.control({"channel": channel, "read": n}))

    async def control(self, control: RelayControl) -> None:
        if self._closed:
            raise ConnectionResetError(CLOSED)
        await self._socket.send_str(json.dumps(control))

    async def _read(self) -> None:
        try:
            async for message in self._socket:
                self._take(message)
        except Exception as exc:
            logger.debug("cloudflare_container: the exec's socket: %s", exc)
        self._lost(ConnectionResetError(CLOSED))

    def _take(self, message: aiohttp.WSMessage) -> None:
        if (data := bytes_of(message)) is not None:
            channel = data[0] if data else 0
            if channel in self._done:
                reader = self._reader(channel)
                if not self._done[channel] or reader.discarding:
                    reader.feed_data(data[1:])
            return
        if message.type is not aiohttp.WSMsgType.TEXT:
            return
        event = frame_of(message.data)
        if event is None:
            return
        if isinstance(took := event.get("took"), int):
            self._untaken -= took
            if self._untaken <= RELAY_WINDOW_BYTES:
                self._free.set()
        elif event.get("closed") == "stdin":
            self.input_closed = True
            self._free.set()
        elif (closed := event.get("closed")) is not None:
            channel = STDOUT_CHANNEL if closed == "stdout" else STDERR_CHANNEL
            if not self._done[channel]:
                self._reader(channel).feed_eof()
            self._end(channel)
        elif isinstance(code := event.get("exit"), int):
            if not self._exit_code.done():
                self._exit_code.set_result(code)
            self._settle()
        elif isinstance(stopped := event.get("stopped"), str):
            self._lost(ConnectionResetError(stopped))

    def _reader(self, channel: int) -> Channel:
        return self._stdout if channel == STDOUT_CHANNEL else self._stderr

    def _end(self, channel: int) -> None:
        self._done[channel] = True
        self._settle()

    def _lost(self, error: Exception) -> None:
        self._closed = True
        self._free.set()
        for channel, done in self._done.items():
            if not done:
                self._reader(channel).set_exception(error)
                self._done[channel] = True
        if not self._exit_code.done():
            self._exit_code.set_exception(error)
            # Read by the caller when it waits; marked so a run that
            # stopped waiting does not log it as never retrieved.
            self._exit_code.exception()

    def _settle(self) -> None:
        if (
            self._exit_code.done()
            and all(self._done.values())
            and not self._closed
        ):
            self._closed = True
            self._spawn(self._shut())

    async def _shut(self) -> None:
        await self._socket.close()

    def _spawn(self, work: Coroutine[None, None, None]) -> None:
        task = asyncio.create_task(work)
        self._tasks.add(task)
        task.add_done_callback(self._settled)

    def _settled(self, task: asyncio.Task[None]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (exc := task.exception()) is not None:
            logger.debug(
                "cloudflare_container: a relay frame not sent: %s", exc
            )


class RelayContainer:
    """A Cloudflare Container reached through a ``ContainerRelay``.

    ``url`` is the relay route that names the container. ``start`` is
    one POST; each exec and each monitor is a socket of its own whose
    first frame carries the token. A socket that closes before its
    process exits is a lost connection, as an exec on a container that
    stopped is.

    Args:
        url (str): the relay route that names the container.
        token (str): the relay's token.
    """

    def __init__(self, url: str, token: str) -> None:
        self._base = url.rstrip("/")
        self._token = token
        self._session: aiohttp.ClientSession | None = None
        self._sockets: set[aiohttp.ClientWebSocketResponse] = set()

    def _client(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def start(self) -> None:
        """Start the container when it is not running; a refusal fails
        with the relay's words."""
        async with self._client().post(
            f"{self._base}/{RELAY_START}",
            headers={"Authorization": f"Bearer {self._token}"},
        ) as response:
            if response.ok:
                return
            said = (await response.text()).strip()
        raise RuntimeError(
            "cloudflare_container: the relay answered "
            f"{response.status} to start" + (f": {said}" if said else "")
        )

    async def _open(self, call: str) -> aiohttp.ClientWebSocketResponse:
        url = f"{self._base}/{call}"
        try:
            socket = await self._client().ws_connect(
                "ws" + url.removeprefix("http"), autoping=True
            )
        except aiohttp.ClientError as exc:
            raise ConnectionError(
                f"could not reach the relay at {url}: {exc}"
            ) from exc
        self._sockets = {open_ for open_ in self._sockets if not open_.closed}
        self._sockets.add(socket)
        return socket

    async def exec(self, cmd: list[str], env: dict[str, str]) -> ExecProcess:
        socket = await self._open(RELAY_EXEC)
        request: RelayRequest = {
            "token": self._token,
            "argv": list(cmd),
            "env": dict(env),
        }
        try:
            await socket.send_str(json.dumps(request))
            async for message in socket:
                if message.type is not aiohttp.WSMsgType.TEXT:
                    continue
                event = frame_of(message.data)
                if event is None:
                    continue
                if event.get("started") is True:
                    process = RelayProcess(socket)
                    process.read()
                    return process
                refusal = event.get("stopped", event.get("refused"))
                if isinstance(refusal, str):
                    raise ConnectionResetError(refusal)
        except BaseException:
            await socket.close()
            raise
        raise ConnectionResetError(
            "the relay closed the exec before it started"
        )

    async def monitor(self) -> None:
        socket = await self._open(RELAY_MONITOR)
        request: RelayRequest = {"token": self._token}
        try:
            await socket.send_str(json.dumps(request))
            async for message in socket:
                if message.type is not aiohttp.WSMsgType.TEXT:
                    continue
                event = frame_of(message.data)
                if event is None:
                    continue
                if isinstance(refused := event.get("refused"), str):
                    raise ConnectionResetError(refused)
                if "exited" in event:
                    if isinstance(error := event["exited"], str):
                        raise RuntimeError(error)
                    return
        finally:
            await socket.close()
        raise ConnectionResetError("the relay closed the monitor")

    async def close(self) -> None:
        """Close the sockets still open, so the relay hears each client
        go, then the HTTP session; the next call opens another."""
        sockets, self._sockets = self._sockets, set()
        for socket in sockets:
            await socket.close()
        if self._session is not None:
            await self._session.close()
            self._session = None
