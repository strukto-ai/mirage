import asyncio
import base64
import binascii
import json
import logging
import re

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from mirage.io.errors import PipeClosed
from mirage.io.pipe import CAPACITY
from mirage.server.e2b import constants
from mirage.server.e2b.connect import StartCommand, decode_start, end_stream
from mirage.server.e2b.errors import (
    InvalidConnectRequest,
    SandboxNotRunning,
    UnsupportedProcessOption,
)
from mirage.server.e2b.routing import require_sandbox
from mirage.server.e2b.sandbox import Sandbox
from mirage.server.e2b.stream import ProcessResponse
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.multipart import MAX_REQUEST_PART
from mirage.types import JsonValue

logger = logging.getLogger(__name__)

_BASE64 = re.compile(r"[A-Za-z0-9+/_-]*={0,2}")


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
