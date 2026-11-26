import asyncio
import base64
import binascii
import json
import logging
import re
from collections.abc import AsyncGenerator
from contextlib import aclosing
from itertools import count

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect
from starlette.types import Message, Receive, Scope, Send

from mirage.concurrency.limiter import owned_task, settle
from mirage.io.errors import PipeClosed
from mirage.io.pipe import CAPACITY, BytePipe
from mirage.server.e2b import constants
from mirage.server.e2b.connect import (
    StartCommand,
    decode_start,
    encode_message,
    end_stream,
)
from mirage.server.e2b.errors import (
    InvalidConnectRequest,
    SandboxNotRunning,
    UnsupportedProcessOption,
)
from mirage.server.e2b.routing import require_sandbox
from mirage.server.e2b.sandbox import LiveProcess, Sandbox
from mirage.server.errors import INTERNAL_MESSAGE, ErrorCode, HttpError
from mirage.server.multipart import MAX_REQUEST_PART
from mirage.types import JsonValue
from mirage.utils.abort import ABORT_JOIN_SECONDS, MirageAbortError

logger = logging.getLogger(__name__)

_BASE64 = re.compile(r"[A-Za-z0-9+/_-]*={0,2}")
_process_ids = count(1)


def _request_deadline(request: Request) -> float | None:
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


async def _read_body(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HttpError(ErrorCode.TOO_LARGE, "command request too large")
        body += chunk
    return bytes(body)


async def _open_process(
    lease: Sandbox, command: StartCommand
) -> tuple[int, LiveProcess]:
    if (
        not lease.entry.accepting_jobs
        or lease.expires_at <= asyncio.get_running_loop().time()
    ):
        raise MirageAbortError()
    stdin = BytePipe() if command.stdin else None
    execution = await lease.entry.runner.ws.shell(
        command.line,
        session_id=lease.session_id,
        cwd=command.cwd if command.cwd is not None else constants.HOME,
        env={**lease.env_vars, **command.envs},
        stdin=stdin.stream() if stdin is not None else None,
        stream=True,
    )
    pid = (next(_process_ids) - 1) % 0xFFFFFFFF + 1
    while pid in lease.processes:
        pid = (next(_process_ids) - 1) % 0xFFFFFFFF + 1
    process = LiveProcess(command, execution, stdin)
    lease.processes[pid] = process

    def release() -> None:
        del lease.processes[pid]
        process.stop_input()

    execution.on_settled(release)
    return pid, process


async def _close_process(process: LiveProcess) -> None:
    process.execution.cancel()
    process.stop_input()
    await process.execution.aclose()


async def _events(
    lease: Sandbox, command: StartCommand
) -> AsyncGenerator[bytes, None]:
    if (
        not lease.entry.accepting_jobs
        or lease.expires_at <= asyncio.get_running_loop().time()
    ):
        raise MirageAbortError()
    runner = lease.entry.runner
    opening = asyncio.create_task(runner.call(_open_process(lease, command)))
    try:
        pid, process = await asyncio.shield(opening)
        yield encode_message({"start": {"pid": pid}})
        try:
            while (
                event := await runner.call(
                    anext(process.execution.events, None)
                )
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
            result = await runner.call(process.execution.wait())
            exit_code, status = result.exit_code, "exited"
        except MirageAbortError:
            if not process.killed:
                raise
            exit_code, status = 137, "signal: killed"
        yield encode_message(
            {
                "end": {
                    "exitCode": exit_code,
                    "exited": True,
                    "status": status,
                }
            }
        )
    finally:
        # Opening keeps its result until both sides have handed it over,
        # even when the client leaves at the same time.
        try:
            _, process = await settle(opening)
        except Exception:
            logger.debug("opening sandbox command failed", exc_info=True)
        else:
            try:
                await settle(owned_task(runner.call(_close_process(process))))
            except RuntimeError:
                if lease.entry.accepting_jobs:
                    raise
                logger.debug("sandbox closed with its command", exc_info=True)


async def _disconnect(receive: Receive) -> None:
    while (await receive())["type"] != "http.disconnect":
        pass


class ProcessResponse(Response):
    """Stream one command until it finishes or its client or lease leaves."""

    def __init__(
        self, lease: Sandbox, command: StartCommand, deadline: float | None
    ) -> None:
        super().__init__(media_type=constants.CONNECT_STREAM)
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
                terminal = end_stream(
                    "deadline_exceeded", constants.DEADLINE_MESSAGE
                )
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
        revoked = asyncio.create_task(self._lease.revoked.wait())
        connection = {sender, disconnected}
        tasks = (*connection, revoked)
        try:
            done, _ = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            if done == {revoked}:
                done, _ = await asyncio.wait(
                    connection,
                    timeout=ABORT_JOIN_SECONDS,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            for task in done:
                await task
        except ClientDisconnect:
            logger.debug("sandbox command connection closed", exc_info=True)
        finally:
            for task in tasks:
                task.cancel()
            for result in await settle(
                asyncio.gather(*tasks, return_exceptions=True)
            ):
                if isinstance(result, Exception):
                    logger.debug(
                        "sandbox command transport closed: %r", result
                    )


def _error(status: int, code: str, message: str) -> Response:
    return JSONResponse({"code": code, "message": message}, status_code=status)


async def start_process(request: Request) -> Response:
    try:
        lease = require_sandbox(request)
        media = request.headers.get("content-type", "").partition(";")[0]
        if media.strip().lower() != constants.CONNECT_STREAM:
            return _error(415, "invalid_argument", "expected Connect JSON")
        deadline = _request_deadline(request)
        loop = asyncio.get_running_loop()
        async with asyncio.timeout_at(deadline):
            command = decode_start(
                await lease.read_body(_read_body, request, MAX_REQUEST_PART)
            )
            if deadline is not None and deadline <= loop.time():
                raise TimeoutError
            lease = require_sandbox(request)
            if request.app.state.registry.draining:
                raise HttpError(
                    ErrorCode.SHUTTING_DOWN, "server is shutting down"
                )
    except InvalidConnectRequest:
        logger.debug("invalid Connect start request", exc_info=True)
        return _error(400, "invalid_argument", "invalid Connect start request")
    except UnsupportedProcessOption as exc:
        return _error(501, "unimplemented", exc.message)
    except HttpError as exc:
        if exc.code == ErrorCode.UNAUTHORIZED:
            return _error(exc.status, "unauthenticated", exc.message)
        if exc.code == ErrorCode.TOO_LARGE:
            return _error(exc.status, "resource_exhausted", exc.message)
        if exc.code == ErrorCode.SHUTTING_DOWN:
            return _error(exc.status, "unavailable", exc.message)
        return _error(exc.status, "invalid_argument", exc.message)
    except TimeoutError:
        return Response(
            end_stream("deadline_exceeded", constants.DEADLINE_MESSAGE),
            media_type=constants.CONNECT_STREAM,
        )
    return ProcessResponse(lease, command, deadline)


def _input_bytes(request: dict[str, JsonValue]) -> bytes:
    value = request.get("input")
    encoded = value.get("stdin") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or value.get("pty") is not None
        or not isinstance(encoded, str)
        or _BASE64.fullmatch(encoded) is None
    ):
        raise InvalidConnectRequest("expected base64 stdin bytes")
    if "=" not in encoded:
        encoded += "=" * (-len(encoded) % 4)
    try:
        return base64.b64decode(encoded, altchars=b"-_", validate=True)
    except binascii.Error as exc:
        raise InvalidConnectRequest("expected base64 stdin bytes") from exc


def _process_info(pid: int, command: StartCommand) -> dict[str, JsonValue]:
    config: dict[str, JsonValue] = {
        "cmd": "/bin/bash",
        "args": ["-l", "-c", command.line],
        "envs": dict(command.envs),
    }
    if command.cwd is not None:
        config["cwd"] = command.cwd
    return {"pid": pid, "config": config}


async def _control(
    lease: Sandbox,
    method: str,
    request: dict[str, JsonValue],
    deadline: float | None,
) -> Response:
    now = asyncio.get_running_loop().time()
    if deadline is not None and deadline <= now:
        return _error(504, "deadline_exceeded", constants.DEADLINE_MESSAGE)
    if not lease.entry.accepting_jobs or lease.expires_at <= now:
        raise SandboxNotRunning()
    if method == "List":
        return JSONResponse(
            {
                "processes": [
                    _process_info(pid, process.command)
                    for pid, process in lease.processes.items()
                    if not process.killed
                ]
            }
        )
    selector = request.get("process")
    pid = selector.get("pid") if isinstance(selector, dict) else None
    if (
        not isinstance(selector, dict)
        or selector.get("tag") is not None
        or type(pid) is not int
        or not 0 < pid <= 0xFFFFFFFF
    ):
        raise InvalidConnectRequest("expected a command PID")
    process = lease.processes.get(pid)
    if process is None or process.killed:
        return _error(404, "not_found", "command not found")
    if method == "SendSignal":
        if request.get("signal") not in (9, "SIGNAL_SIGKILL"):
            return _error(501, "unimplemented", "only SIGKILL is supported")
        process.killed = True
        process.execution.cancel()
        process.stop_input()
        return JSONResponse({})
    stdin = process.stdin
    if stdin is None or stdin.closed_reader:
        return _error(400, "failed_precondition", "command stdin is closed")
    if method == "CloseStdin":
        stdin.end()
        # The reader still owns the buffered bytes and can read to EOF.
        process.stdin = None
    else:
        data = _input_bytes(request)
        if len(data) + stdin.buffered_bytes > CAPACITY:
            return _error(
                429, "resource_exhausted", "command stdin buffer is full"
            )
        try:
            await stdin.write(data)
        except PipeClosed:
            return _error(
                400, "failed_precondition", "command stdin is closed"
            )
    return JSONResponse({})


async def control_process(request: Request) -> Response:
    try:
        lease = require_sandbox(request)
        media = request.headers.get("content-type", "").partition(";")[0]
        if media.strip().lower() != "application/json":
            return _error(415, "invalid_argument", "expected Connect JSON")
        deadline = _request_deadline(request)
        timeout = asyncio.timeout_at(deadline)
        try:
            async with timeout:
                if (
                    deadline is not None
                    and deadline <= asyncio.get_running_loop().time()
                ):
                    raise TimeoutError
                body = json.loads(
                    (
                        await lease.read_body(
                            _read_body, request, constants.MAX_CONTROL_BODY
                        )
                    ).decode()
                )
                if not isinstance(body, dict):
                    raise InvalidConnectRequest("expected a command request")
                lease = require_sandbox(request)
                method = request.url.path.rsplit("/", 1)[-1]
                return await lease.entry.runner.call(
                    _control(lease, method, body, deadline)
                )
        except TimeoutError:
            if not timeout.expired() and (
                deadline is None
                or deadline > asyncio.get_running_loop().time()
            ):
                raise
            response = _error(
                504, "deadline_exceeded", constants.DEADLINE_MESSAGE
            )
            response.headers["Connection"] = "close"
            return response
    except HttpError as exc:
        code = {
            ErrorCode.UNAUTHORIZED: "unauthenticated",
            ErrorCode.TOO_LARGE: "resource_exhausted",
        }.get(exc.code, "invalid_argument")
        return _error(exc.status, code, exc.message)
    except (ValueError, RecursionError):
        logger.debug("invalid Connect command request", exc_info=True)
        return _error(
            400, "invalid_argument", "invalid Connect command request"
        )
