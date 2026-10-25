import asyncio
import base64
import json
import logging

from starlette.requests import Request
from starlette.responses import Response
from starlette.types import Receive, Scope, Send

from mirage.concurrency.limiter import on_loop, settle
from mirage.execution.types import ExecutionRecord
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.types import StreamName
from mirage.server.jobs import ExecutionTable
from mirage.server.stdin import UploadStdin
from mirage.workspace.shell_execution import ShellExecution

logger = logging.getLogger(__name__)
PAYLOAD_SIZE = CHUNK_SIZE // 2


def record(stream: StreamName, data: bytes) -> bytes:
    """One output event as wire records, a line each, every one holding
    at most PAYLOAD_SIZE bytes of it.

    Args:
        stream (StreamName): the stream the bytes were written to.
        data (bytes): the bytes.
    """
    return b"".join(
        (
            json.dumps(
                {
                    "stream": stream,
                    "data": base64.b64encode(
                        data[offset : offset + PAYLOAD_SIZE]
                    ).decode("ascii"),
                },
                separators=(",", ":"),
            )
            + "\n"
        ).encode()
        for offset in range(0, len(data), PAYLOAD_SIZE)
    )


class ShellResponse(Response):
    """Stream one job and join its cleanup if the HTTP caller disappears.

    The job opens the line's execution and waits for its status; the
    response reads the execution's events where the workspace runs and
    sends each as its records, so a caller that reads slowly holds the
    line back. The upload owns ASGI receive until it ends; only then does
    the disconnect watcher read it. Output and input may progress
    concurrently. The final record goes out as soon as the job settles:
    stdin the line did not read never ends a line, as ``ssh host cmd``
    returns while its input is still open. The body then ends only once
    the rest of the upload is discarded or the caller hangs up, so the
    caller finishes sending before the connection closes.
    """

    def __init__(
        self,
        execution: "asyncio.Future[ShellExecution | None]",
        loop: asyncio.AbstractEventLoop,
        jobs: ExecutionTable,
        job: ExecutionRecord,
        request: Request,
        upload: asyncio.Task[None] | None,
        part: UploadStdin | None,
    ) -> None:
        super().__init__(
            media_type="application/x-ndjson",
            headers={"X-Mirage-Job-Id": job.id, "Connection": "close"},
        )
        del self.headers["content-length"]
        self._execution = execution
        self._loop = loop
        self._jobs = jobs
        self._job = job
        self._request = request
        self._upload = upload
        self._part = part

    async def _completed(self) -> ExecutionRecord:
        finished = await self._jobs.wait(self._job.id)
        await self._jobs.drain(self._job.id)
        # A job cancelled before its work started never opened the line.
        if not self._execution.done():
            self._execution.set_result(None)
        return finished

    async def _disconnected(self) -> None:
        if self._upload is not None:
            try:
                await asyncio.shield(self._upload)
            except Exception:
                logger.debug("streamed shell upload failed", exc_info=True)
                self._jobs.cancel(self._job.id)
        while (await self._request.receive())["type"] != "http.disconnect":
            pass

    async def _send(
        self, send: Send, completed: asyncio.Task[ExecutionRecord]
    ) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": self.status_code,
                "headers": self.raw_headers,
            }
        )
        # Shielded: a hang-up cancels this task, and the handover must
        # still reach _close, which closes the line.
        execution = await asyncio.shield(self._execution)
        while execution is not None:
            try:
                event = await on_loop(
                    anext(execution.events, None), self._loop
                )
            except Exception:
                # The line failed or was stopped: its status says so in
                # the final record.
                logger.debug("streamed shell output ended", exc_info=True)
                break
            if event is None:
                break
            await send(
                {
                    "type": "http.response.body",
                    "body": record(event.stream, event.data),
                    "more_body": True,
                }
            )
        job = await asyncio.shield(completed)
        upload_error: BaseException | None = (
            self._part.error if self._part is not None else None
        )
        if (
            upload_error is None
            and self._upload is not None
            and self._upload.done()
            and not self._upload.cancelled()
        ):
            upload_error = self._upload.exception()
        terminal = (
            json.dumps(
                {
                    "status": job.status.value
                    if upload_error is None
                    else "failed",
                    "result": job.result if upload_error is None else None,
                    "error": job.error
                    if upload_error is None
                    else str(upload_error),
                },
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        await send(
            {
                "type": "http.response.body",
                "body": terminal,
                "more_body": True,
            }
        )
        if self._upload is not None:
            if self._part is not None:
                await self._part.discard()
            try:
                await asyncio.shield(self._upload)
            except Exception:
                logger.debug("streamed shell upload failed", exc_info=True)
        await send(
            {"type": "http.response.body", "body": b"", "more_body": False}
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
        completed: asyncio.Task[ExecutionRecord],
        sender: asyncio.Task[None],
        disconnected: asyncio.Task[None],
    ) -> None:
        self._jobs.cancel(self._job.id)
        if self._part is not None:
            await self._part.discard()
        sender.cancel()
        disconnected.cancel()
        if self._upload is not None:
            self._upload.cancel()
        try:
            await self._jobs.drain(self._job.id)
        finally:
            # The job has handed over its execution or never will: what
            # the caller left unread goes with it.
            execution = await settle(self._execution)
            if execution is not None:
                await on_loop(execution.aclose(), self._loop)
            completed.cancel()
            tasks = [sender, disconnected, completed]
            if self._upload is not None:
                tasks.append(self._upload)
            for result in await asyncio.gather(*tasks, return_exceptions=True):
                if isinstance(result, Exception):
                    logger.debug("stream transport closed: %r", result)
