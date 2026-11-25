import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal

from anyio import CancelScope
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from mirage.io.stream import close_quietly
from mirage.server.e2b.files import (
    FileCode,
    FileError,
    SandboxFiles,
    file_error,
)
from mirage.server.e2b.leases import Sandbox
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.multipart import PartEvent, part_events
from mirage.server.routers.vfs import json_body, session_of

logger = logging.getLogger(__name__)

FILES = "/files"
RPC_PREFIX = "/filesystem.Filesystem/"
FileMethod = Literal["Stat", "ListDir", "MakeDir", "Remove"]
METHODS: tuple[FileMethod, ...] = ("Stat", "ListDir", "MakeDir", "Remove")
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
CONNECT_STATUS: dict[FileCode, int] = {
    "invalid_argument": 400,
    "failed_precondition": 400,
    "permission_denied": 403,
    "not_found": 404,
    "already_exists": 409,
    "resource_exhausted": 429,
    "internal": 500,
    "unimplemented": 501,
}
HTTP_CONNECT_CODE = {
    400: "invalid_argument",
    401: "unauthenticated",
    403: "permission_denied",
    404: "not_found",
    413: "resource_exhausted",
    429: "resource_exhausted",
    503: "unavailable",
}

RequireSandbox = Callable[[Request], Sandbox]


def _failure(exc: Exception, *, connect: bool = False) -> JSONResponse:
    if isinstance(exc, HttpError):
        code = (
            HTTP_CONNECT_CODE.get(exc.status, "internal")
            if connect
            else exc.status
        )
        return JSONResponse(
            {"code": code, "message": exc.message},
            status_code=exc.status,
            headers=exc.headers,
        )
    failure = file_error(exc)
    if failure.code == "internal":
        logger.warning("sandbox file operation failed", exc_info=True)
    status = CONNECT_STATUS[failure.code]
    if not connect and failure.code == "resource_exhausted":
        status = 507
    return JSONResponse(
        {"code": failure.code if connect else status, "message": str(failure)},
        status_code=status,
    )


def _query_path(request: Request) -> str:
    paths = request.query_params.getlist("path")
    if len(paths) != 1 or not paths[0] or "\0" in paths[0]:
        raise FileError("invalid_argument", "one file path is required")
    return paths[0]


async def _upload_body(request: Request) -> AsyncIterator[bytes]:
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise HttpError(ErrorCode.TOO_LARGE, "file upload is too large")
        yield chunk


async def _multipart_file(request: Request) -> bytes:
    content_type = request.headers.get("content-type", "")
    if content_type.partition(";")[0].strip().lower() != "multipart/form-data":
        raise FileError("invalid_argument", "expected a multipart file upload")
    found = False
    body = bytearray()
    async for event, data in part_events(_upload_body(request), content_type):
        if event is PartEvent.BEGIN:
            if found or data != b"file":
                raise FileError("invalid_argument", "expected one file part")
            found = True
        elif event is PartEvent.DATA:
            body.extend(data)
    if not found:
        raise FileError("invalid_argument", "expected one file part")
    return bytes(body)


async def _files_of(lease: Sandbox) -> SandboxFiles:
    session = await session_of(lease.entry, lease.session_id)
    return SandboxFiles(session.vfs)


async def _download(lease: Sandbox, path: str) -> StreamingResponse:
    runner = lease.entry.runner
    files = await _files_of(lease)
    source = await runner.call(files.read(path))

    async def pull() -> bytes:
        return await anext(source)

    async def output() -> AsyncIterator[bytes]:
        try:
            while True:
                try:
                    yield await runner.call(pull())
                except StopAsyncIteration:
                    return
        finally:
            with CancelScope(shield=True):
                await runner.call(close_quietly(source))

    return StreamingResponse(
        output(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


def file_router(require_sandbox: RequireSandbox) -> APIRouter:
    router = APIRouter(include_in_schema=False)

    @router.get(FILES)
    async def download(request: Request) -> Response:
        try:
            lease = require_sandbox(request)
            return await _download(lease, _query_path(request))
        except Exception as exc:
            return _failure(exc)

    @router.post(FILES)
    async def upload(request: Request) -> Response:
        try:
            require_sandbox(request)
            path = _query_path(request)
            data = await _multipart_file(request)
            lease = require_sandbox(request)
            files = await _files_of(lease)
            written = await lease.entry.runner.call(files.write(path, data))
            return JSONResponse([written])
        except Exception as exc:
            return _failure(exc)

    for method in METHODS:
        router.add_api_route(
            RPC_PREFIX + method,
            _rpc_endpoint(method, require_sandbox),
            methods=["POST"],
        )

    return router


def _rpc_endpoint(
    method: FileMethod, require_sandbox: RequireSandbox
) -> Callable[[Request], Awaitable[Response]]:
    async def endpoint(request: Request) -> Response:
        try:
            lease = require_sandbox(request)
            body = await json_body(request)
            path = body.get("path")
            if not isinstance(path, str):
                raise FileError("invalid_argument", "expected a file path")
            files = await _files_of(lease)
            runner = lease.entry.runner
            if method == "Stat":
                return JSONResponse(
                    {"entry": await runner.call(files.stat(path))}
                )
            if method == "ListDir":
                depth = body.get("depth", 1)
                if type(depth) is not int:
                    raise FileError(
                        "invalid_argument", "list depth must be one or two"
                    )
                return JSONResponse(
                    {"entries": await runner.call(files.list_dir(path, depth))}
                )
            if method == "MakeDir":
                await runner.call(files.mkdir(path))
            else:
                await runner.call(files.remove(path))
            return JSONResponse({})
        except Exception as exc:
            return _failure(exc, connect=True)

    return endpoint
