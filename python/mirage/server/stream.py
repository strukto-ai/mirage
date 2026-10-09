import asyncio
import base64
import json
import logging

from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

from mirage.concurrency.limiter import settle
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.pipe import CAPACITY, BytePipe
from mirage.server.jobs import JobEntry, JobTable
from mirage.server.stdin import UploadStdin
from mirage.shell.console.job_console import JobConsole
from mirage.shell.console.types import Channel

logger = logging.getLogger(__name__)
PAYLOAD_SIZE = CHUNK_SIZE // 2


class ShellOutput(JobConsole):
    """A foreground transport, with bounded writes on the server loop.

    Each encoded record fits one pipe chunk, so cancelling a blocked write
    cannot leave an incomplete record among the accepted output bytes.
    """

    def __init__(self, capacity: int = CAPACITY) -> None:
        super().__init__()
        self.pipe = BytePipe(capacity)
        self._loop = asyncio.get_running_loop()
        self._write_lock = asyncio.Lock()

    async def emit(self, channel: Channel, data: bytes) -> None:
        if channel == Channel.CONTROL:
            return
        if asyncio.get_running_loop() is self._loop:
            await self._emit(channel, data)
        else:
            await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(
                    self._emit(channel, data), self._loop
                )
            )

    async def _emit(self, channel: Channel, data: bytes) -> None:
        async with self._write_lock:
            for offset in range(0, len(data), PAYLOAD_SIZE):
                await self.pipe.write(
                    (
                        json.dumps(
                            {
                                "stream": channel.value,
                                "data": base64.b64encode(
                                    data[offset : offset + PAYLOAD_SIZE]
                                ).decode("ascii"),
                            },
                            separators=(",", ":"),
                        )
                        + "\n"
                    ).encode()
                )


class ShellResponse(Response):
    """Stream one job and join its cleanup if the HTTP caller disappears.

    The upload owns ASGI receive until it ends; only then does the
    disconnect watcher read it. Output and input may progress concurrently.
    """

    def __init__(
        self,
        output: ShellOutput,
        jobs: JobTable,
        job: JobEntry,
        request: Request,
        upload: asyncio.Task[None] | None,
        part: UploadStdin | None,
    ) -> None:
        super().__init__(
            media_type="application/x-ndjson",
            headers={"X-Mirage-Job-Id": job.id, "Connection": "close"},
        )
        del self.headers["content-length"]
        self._output = output
        self._jobs = jobs
        self._job = job
        self._request = request
        self._upload = upload
        self._part = part

    async def _completed(self) -> JobEntry:
        try:
            await self._jobs.drain(self._job.id)
            return await self._jobs.wait(self._job.id)
        finally:
            self._output.pipe.end()

    async def _disconnected(self) -> None:
        if self._upload is not None:
            try:
                await asyncio.shield(self._upload)
            except Exception:
                logger.debug("streamed shell upload failed", exc_info=True)
                return
        while (await self._request.receive())["type"] != "http.disconnect":
            pass

    async def _send(
        self, send: Send, completed: asyncio.Task[JobEntry]
    ) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": self.status_code,
                "headers": self.raw_headers,
            }
        )
        async for chunk in self._output.pipe.stream():
            await send(
                {
                    "type": "http.response.body",
                    "body": chunk,
                    "more_body": True,
                }
            )
        job = await asyncio.shield(completed)
        terminal = (
            json.dumps(
                {
                    "status": job.status.value,
                    "result": job.result,
                    "error": job.error,
                },
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        await send(
            {
                "type": "http.response.body",
                "body": terminal,
                "more_body": False,
            }
        )

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        completed = asyncio.create_task(self._completed())
        sender = asyncio.create_task(self._send(send, completed))
        disconnected = asyncio.create_task(self._disconnected())
        try:
            await asyncio.wait(
                {sender, disconnected}, return_when=asyncio.FIRST_COMPLETED
            )
            if sender.done():
                await sender
        finally:
            await settle(
                asyncio.create_task(
                    self._close(completed, sender, disconnected)
                )
            )

    async def _close(
        self,
        completed: asyncio.Task[JobEntry],
        sender: asyncio.Task[None],
        disconnected: asyncio.Task[None],
    ) -> None:
        self._output.pipe.close_reader()
        if self._part is not None:
            self._part.discard()
        sender.cancel()
        disconnected.cancel()
        if self._upload is not None:
            self._upload.cancel()
        try:
            await self._jobs.cancel(self._job.id)
        finally:
            try:
                await self._jobs.drain(self._job.id)
            finally:
                completed.cancel()
                tasks = [sender, disconnected, completed]
                if self._upload is not None:
                    tasks.append(self._upload)
                for result in await asyncio.gather(
                    *tasks, return_exceptions=True
                ):
                    if isinstance(result, Exception):
                        logger.debug("stream transport closed: %r", result)
                await self._output.close()
