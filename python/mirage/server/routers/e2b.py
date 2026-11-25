import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from typing import Any, Literal

from anyio import CancelScope
from fastapi import APIRouter, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field, StrictStr
from starlette.routing import Match
from starlette.types import Scope

from mirage.io.stream import close_quietly
from mirage.server.e2b.files import (
    FileCode,
    FileError,
    SandboxFiles,
    file_error,
)
from mirage.server.e2b.leases import Sandbox, Sandboxes
from mirage.server.e2b.process import start_process
from mirage.server.e2b.routing import SandboxNotRunning, require_sandbox
from mirage.server.errors import INTERNAL_MESSAGE, ErrorCode, HttpError
from mirage.server.multipart import PartEvent, part_events
from mirage.server.routers.vfs import json_body, session_of
from mirage.server.routers.workspaces import open_workspace, template_config
from mirage.server.schemas import check_config
from mirage.utils.ids import new_workspace_id

logger = logging.getLogger(__name__)

BASE_TEMPLATE = "base"
DEFAULT_TIMEOUT = 300
ENVD_VERSION = "0.5.6"
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


class LifecycleRoute(APIRoute):
    def get_route_handler(
        self,
    ) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handle = super().get_route_handler()

        async def dispatch(request: Request) -> Response:
            try:
                return await handle(request)
            except HttpError as exc:
                return JSONResponse(
                    {"code": exc.status, "message": exc.message},
                    status_code=exc.status,
                    headers=exc.headers,
                )
            except RequestValidationError:
                return JSONResponse(
                    {"code": 400, "message": "invalid sandbox request"},
                    status_code=400,
                )

        return dispatch


router = APIRouter(route_class=LifecycleRoute, include_in_schema=False)
data_router = APIRouter(include_in_schema=False)
data_router.add_api_route(
    "/process.Process/Start", start_process, methods=["POST"]
)


@data_router.get("/health", status_code=204)
async def sandbox_health(request: Request) -> Response:
    try:
        require_sandbox(request)
    except SandboxNotRunning:
        return Response(status_code=502)
    except HttpError as exc:
        return JSONResponse(
            {"code": exc.status, "message": exc.message},
            status_code=exc.status,
        )
    return Response(status_code=204)


class ConnectSandboxRequest(BaseModel):
    timeout: int = Field(
        default=DEFAULT_TIMEOUT, strict=True, gt=0, le=2**53 - 1
    )


class CreateSandboxRequest(ConnectSandboxRequest):
    template: str = Field(default=BASE_TEMPLATE, alias="templateID")
    env_vars: dict[str, StrictStr] = Field(
        default_factory=dict, alias="envVars"
    )


class SetSandboxTimeoutRequest(BaseModel):
    timeout: int = Field(strict=True, ge=0, le=2**31 - 1)


def is_lifecycle_request(scope: Scope) -> bool:
    return any(
        route.matches(scope)[0] is Match.FULL for route in router.routes
    )


def is_data_request(scope: Scope) -> bool:
    return any(
        route.matches(scope)[0] is Match.FULL for route in data_router.routes
    )


def _present(lease: Sandbox, template: str) -> dict[str, str]:
    return {
        "sandboxID": lease.entry.id,
        "templateID": template,
        "clientID": lease.entry.id,
        "envdVersion": ENVD_VERSION,
        "envdAccessToken": lease.access_token,
    }


@router.post("/v2/sandboxes", status_code=201)
async def create_sandbox(
    request: Request,
    response: Response,
    req: CreateSandboxRequest = CreateSandboxRequest(),
) -> dict[str, str]:
    override: str | None = request.app.state.e2b_template
    template = override or BASE_TEMPLATE
    if req.template not in (BASE_TEMPLATE, template):
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox template not found")
    if override is None:
        written: dict[str, Any] = {
            "mode": "read",
            "mounts": {"/home/user": {"vfs": "ram", "mode": "write"}},
        }
        config = check_config(written)
    else:
        config, written = await template_config(request, override)
    entry = await open_workspace(
        request, response, new_workspace_id(), config, written, ephemeral=True
    )
    sandboxes: Sandboxes = request.app.state.e2b
    return _present(sandboxes.add(entry, req.env_vars, req.timeout), template)


@router.post("/v2/sandboxes/{sandbox_id}/connect")
async def connect_sandbox(
    sandbox_id: str,
    request: Request,
    req: ConnectSandboxRequest = ConnectSandboxRequest(),
) -> dict[str, str]:
    sandboxes: Sandboxes = request.app.state.e2b
    lease = sandboxes.reconnect(sandbox_id, request.state.account, req.timeout)
    if lease is None:
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox not found")
    return _present(lease, request.app.state.e2b_template or BASE_TEMPLATE)


@router.post("/sandboxes/{sandbox_id}/timeout", status_code=204)
async def set_sandbox_timeout(
    sandbox_id: str, request: Request, req: SetSandboxTimeoutRequest
) -> Response:
    sandboxes: Sandboxes = request.app.state.e2b
    if not sandboxes.set_timeout(
        sandbox_id, request.state.account, req.timeout
    ):
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox not found")
    return Response(status_code=204)


@router.delete("/sandboxes/{sandbox_id}", status_code=204)
async def kill_sandbox(sandbox_id: str, request: Request) -> Response:
    sandboxes: Sandboxes = request.app.state.e2b
    removed = await sandboxes.kill(sandbox_id, request.state.account)
    if removed is None:
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox not found")
    if not removed:
        raise HttpError(ErrorCode.INTERNAL, INTERNAL_MESSAGE)
    return Response(status_code=204)


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


@data_router.get(FILES)
async def download(request: Request) -> Response:
    try:
        lease = require_sandbox(request)
        return await _download(lease, _query_path(request))
    except Exception as exc:
        return _failure(exc)


@data_router.post(FILES)
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


def _rpc_endpoint(
    method: FileMethod,
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


for method in METHODS:
    data_router.add_api_route(
        RPC_PREFIX + method, _rpc_endpoint(method), methods=["POST"]
    )
