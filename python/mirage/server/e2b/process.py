import asyncio
import base64
import logging
from collections.abc import AsyncGenerator
from contextlib import aclosing
from itertools import count

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect
from starlette.types import Message, Receive, Scope, Send

from mirage.concurrency.limiter import owned_task, settle
from mirage.server.e2b.connect import (
    InvalidConnectRequest,
    StartCommand,
    decode_start,
    encode_message,
    end_stream,
)
from mirage.server.e2b.leases import Sandbox
from mirage.server.e2b.routing import require_sandbox
from mirage.server.errors import INTERNAL_MESSAGE, ErrorCode, HttpError
from mirage.server.multipart import MAX_REQUEST_PART
from mirage.utils.abort import MirageAbortError

logger = logging.getLogger(__name__)

CONNECT_STREAM = "application/connect+json"
DEADLINE_MESSAGE = "command deadline exceeded"
_process_ids = count(1)


def _deadline(request: Request) -> float | None:
    values = request.headers.getlist("connect-timeout-ms")
    if not values:
        return None
    value = values[0]
    if (
        len(values) != 1
        or not 1 <= len(value) <= 10
        or not value.isascii()
        or not value.isdecimal()
    ):
        raise InvalidConnectRequest("invalid Connect-Timeout-Ms")
    return asyncio.get_running_loop().time() + int(value) / 1000


async def _read_start(request: Request) -> StartCommand:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_REQUEST_PART:
            raise HttpError(ErrorCode.TOO_LARGE, "command request too large")
        body += chunk
    return decode_start(bytes(body))


async def _events(
    lease: Sandbox, command: StartCommand
) -> AsyncGenerator[bytes, None]:
    if (
        not lease.entry.accepting_jobs
        or lease.expires_at <= asyncio.get_running_loop().time()
    ):
        raise MirageAbortError()
    runner = lease.entry.runner
    opening = asyncio.create_task(
        runner.call(
            runner.ws.shell(
                command.line,
                session_id=lease.session_id,
                cwd=command.cwd if command.cwd is not None else "/home/user",
                env={**lease.env_vars, **command.envs},
                stream=True,
            )
        )
    )
    try:
        execution = await asyncio.shield(opening)
        yield encode_message({"start": {"pid": next(_process_ids)}})
        while (
            event := await runner.call(anext(execution.events, None))
        ) is not None:
            yield encode_message(
                {
                    "data": {
                        event.stream: base64.b64encode(event.data).decode(
                            "ascii"
                        )
                    }
                }
            )
        result = await runner.call(execution.wait())
        yield encode_message(
            {
                "end": {
                    "exitCode": result.exit_code,
                    "exited": True,
                    "status": "exited",
                }
            }
        )
    finally:
        # Opening keeps its result until both sides have handed it over,
        # even when the client leaves at the same time.
        try:
            execution = await settle(opening)
        except Exception:
            logger.debug("opening sandbox command failed", exc_info=True)
        else:
            try:
                await settle(owned_task(runner.call(execution.aclose())))
            except RuntimeError:
                if lease.entry.accepting_jobs:
                    raise
                logger.debug("sandbox closed with its command", exc_info=True)


async def _disconnect(receive: Receive) -> None:
    while (await receive())["type"] != "http.disconnect":
        pass


class ProcessResponse(Response):
    """Stream one command and settle its execution on hang-up or timeout."""

    def __init__(
        self, lease: Sandbox, command: StartCommand, deadline: float | None
    ) -> None:
        super().__init__(media_type=CONNECT_STREAM)
        del self.headers["content-length"]
        self._lease = lease
        self._command = command
        self._deadline = deadline

    async def _send(self, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": self.status_code,
                "headers": self.raw_headers,
            }
        )
        terminal = end_stream()
        timeout = asyncio.timeout_at(self._deadline)
        try:
            async with (
                timeout,
                aclosing(_events(self._lease, self._command)) as events,
            ):
                async for frame in events:
                    await send(
                        {
                            "type": "http.response.body",
                            "body": frame,
                            "more_body": True,
                        }
                    )
        except TimeoutError:
            if timeout.expired():
                terminal = end_stream("deadline_exceeded", DEADLINE_MESSAGE)
            else:
                logger.exception("sandbox command raised a timeout")
                terminal = end_stream("internal", INTERNAL_MESSAGE)
        except ClientDisconnect:
            raise
        except MirageAbortError:
            terminal = end_stream("canceled", "command canceled")
        except Exception:
            if self._lease.entry.accepting_jobs:
                logger.exception("sandbox command failed")
                terminal = end_stream("internal", INTERNAL_MESSAGE)
            else:
                terminal = end_stream("canceled", "sandbox closed")
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
        async def connected(message: Message) -> None:
            try:
                await send(message)
            except OSError as exc:
                raise ClientDisconnect() from exc

        sender = asyncio.create_task(self._send(connected))
        disconnected = asyncio.create_task(_disconnect(receive))
        try:
            done, _ = await asyncio.wait(
                {sender, disconnected}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in done:
                await task
        except ClientDisconnect:
            logger.debug("sandbox command connection closed", exc_info=True)
        finally:
            sender.cancel()
            disconnected.cancel()
            for result in await settle(
                asyncio.gather(sender, disconnected, return_exceptions=True)
            ):
                if isinstance(result, Exception):
                    logger.debug(
                        "sandbox command transport closed: %r", result
                    )


def _error(status: int, code: str, message: str) -> Response:
    return JSONResponse({"code": code, "message": message}, status_code=status)


async def start_process(request: Request) -> Response:
    try:
        require_sandbox(request)
        media = request.headers.get("content-type", "").partition(";")[0]
        if media.strip().lower() != CONNECT_STREAM:
            return _error(415, "invalid_argument", "expected Connect JSON")
        deadline = _deadline(request)
        loop = asyncio.get_running_loop()
        async with asyncio.timeout_at(deadline):
            command = await _read_start(request)
            if deadline is not None and deadline <= loop.time():
                raise TimeoutError
            lease = require_sandbox(request)
    except InvalidConnectRequest:
        logger.debug("invalid Connect start request", exc_info=True)
        return _error(400, "invalid_argument", "invalid Connect start request")
    except HttpError as exc:
        if exc.code == ErrorCode.UNAUTHORIZED:
            return _error(exc.status, "unauthenticated", exc.message)
        if exc.code == ErrorCode.TOO_LARGE:
            return _error(exc.status, "resource_exhausted", exc.message)
        return _error(exc.status, "invalid_argument", exc.message)
    except TimeoutError:
        return Response(
            end_stream("deadline_exceeded", DEADLINE_MESSAGE),
            media_type=CONNECT_STREAM,
        )
    return ProcessResponse(lease, command, deadline)
