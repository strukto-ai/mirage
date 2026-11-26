import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Coroutine
from typing import Any, Literal

from anyio import CancelScope
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from starlette.routing import Match
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from mirage.io.stream import close_quietly
from mirage.server.auth.middleware import (
    CredentialRejected,
    CredentialVerifier,
    admit_account,
)
from mirage.server.constants import RAW_BODIES
from mirage.server.e2b.files import (
    FileCode,
    FileError,
    SandboxFiles,
    file_error,
)
from mirage.server.e2b.leases import Sandbox, Sandboxes, SandboxNotRunning
from mirage.server.e2b.process import (
    CONNECT_STREAM,
    CONTROL_METHODS,
    PROCESS_PREFIX,
    control_process,
    start_process,
)
from mirage.server.e2b.routing import require_sandbox
from mirage.server.errors import INTERNAL_MESSAGE, ErrorCode, HttpError
from mirage.server.multipart import MAX_REQUEST_PART, PartEvent, part_events
from mirage.server.routers.vfs import json_body, session_of
from mirage.server.routers.workspaces import open_workspace, template_config
from mirage.server.schemas import check_config
from mirage.utils.ids import new_workspace_id

logger = logging.getLogger(__name__)

BASE_TEMPLATE = "base"
BASE_WORKSPACE_TEMPLATE = "e2b-base"
DEFAULT_TIMEOUT = 300
ENVD_VERSION = "0.5.6"
FILES = "/files"
RPC_PREFIX = "/filesystem.Filesystem/"
FileMethod = Literal["Stat", "ListDir", "MakeDir", "Move", "Remove"]
METHODS: tuple[FileMethod, ...] = (
    "Stat",
    "ListDir",
    "MakeDir",
    "Move",
    "Remove",
)
UNSUPPORTED_LIFECYCLE_ROUTES = (
    ("GET", "/v2/sandboxes"),
    ("GET", "/sandboxes"),
    ("GET", "/sandboxes/{sandbox_id}"),
    ("GET", "/sandboxes/{sandbox_id}/metrics"),
    ("POST", "/sandboxes/{sandbox_id}/pause"),
    ("POST", "/sandboxes/{sandbox_id}/resume"),
)
UNSUPPORTED_RPC_PATHS = (
    RPC_PREFIX + "WatchDir",
    RPC_PREFIX + "CreateWatcher",
    RPC_PREFIX + "GetWatcherEvents",
    RPC_PREFIX + "RemoveWatcher",
    "/process.Process/Connect",
    "/process.Process/Update",
    "/process.Process/StreamInput",
)
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
            received = 0

            async def receive() -> Message:
                nonlocal received
                message = await request.receive()
                if message["type"] == "http.request":
                    received += len(message.get("body", b""))
                    if received > MAX_REQUEST_PART:
                        raise HTTPException(
                            413, "sandbox request is too large"
                        )
                return message

            try:
                media = (
                    request.headers.get("content-type", "")
                    .partition(";")[0]
                    .strip()
                    .lower()
                )
                if media == CONNECT_STREAM or media.encode().startswith(
                    RAW_BODIES
                ):
                    raise HttpError(
                        ErrorCode.INVALID_REQUEST,
                        "expected JSON on a unary E2B route",
                        headers={"Connection": "close"},
                    )
                return await handle(Request(request.scope, receive))
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
            except HTTPException as exc:
                if exc.status_code != 413:
                    raise
                return JSONResponse(
                    {"code": 413, "message": "sandbox request is too large"},
                    status_code=413,
                )

        return dispatch


router = APIRouter(route_class=LifecycleRoute, include_in_schema=False)
data_router = APIRouter(include_in_schema=False)
data_router.add_api_route(
    f"{PROCESS_PREFIX}Start", start_process, methods=["POST"]
)
for method in CONTROL_METHODS:
    data_router.add_api_route(
        f"{PROCESS_PREFIX}{method}", control_process, methods=["POST"]
    )


@data_router.get("/health", status_code=204)
async def sandbox_health(request: Request) -> Response:
    try:
        require_sandbox(request)
    except HttpError as exc:
        if exc.code == ErrorCode.UNAUTHORIZED:
            return Response(status_code=502)
        return JSONResponse(
            {"code": exc.status, "message": exc.message},
            status_code=exc.status,
        )
    return Response(status_code=204)


class ConnectSandboxRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

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


class SandboxAuthMiddleware:
    def __init__(self, app: ASGIApp, verifier: CredentialVerifier) -> None:
        self.app = app
        self.verifier = verifier

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] == "http":
            if is_lifecycle_request(scope):
                keys = Request(scope).headers.getlist("x-api-key")
                try:
                    if len(keys) != 1 or not keys[0].strip():
                        raise CredentialRejected("missing API key")
                    account = await self.verifier.account(keys[0].strip())
                except CredentialRejected as exc:
                    logger.debug("sandbox API key rejected: %s", exc)
                    response = JSONResponse(
                        {"code": 401, "message": "unauthorized"},
                        status_code=401,
                    )
                    await response(scope, receive, send)
                    return
                admit_account(scope, account)
            elif is_data_request(scope):
                lease = _sandbox_access(scope)
                admit_account(
                    scope, None if lease is None else lease.entry.owner
                )
        await self.app(scope, receive, send)


def rate_limit_error(scope: Scope, error: HttpError) -> JSONResponse:
    return failure(error, connect=is_data_request(scope))


def _sandbox_access(scope: Scope) -> Sandbox | None:
    try:
        return require_sandbox(Request(scope))
    except HttpError:
        logger.debug("sandbox access could not be verified", exc_info=True)
        return None


def sandbox_workspace(scope: Scope) -> str | None:
    """Identify the workspace after a sandbox token or lease owner check.

    Args:
        scope (Scope): the request scope after authentication.
    """
    if scope["type"] != "http":
        return None
    if is_data_request(scope):
        lease = _sandbox_access(scope)
        return None if lease is None else lease.entry.id
    for route in router.routes:
        match, child = route.matches(scope)
        if match is not Match.FULL:
            continue
        sandbox_id = child.get("path_params", {}).get("sandbox_id")
        if not isinstance(sandbox_id, str):
            return None
        request = Request(scope)
        sandboxes: Sandboxes = request.app.state.e2b
        lease = sandboxes.owned(sandbox_id, request.state.account)
        return None if lease is None else lease.entry.id
    return None


def _present(lease: Sandbox) -> dict[str, str]:
    return {
        "sandboxID": lease.entry.id,
        "templateID": BASE_TEMPLATE,
        "clientID": lease.entry.id,
        "envdVersion": ENVD_VERSION,
        "envdAccessToken": lease.access_token,
    }


def unsupported_create_option(options: dict[str, Any]) -> str | None:
    for name, value in options.items():
        if name == "metadata" and value == {}:
            continue
        if name == "allow_internet_access" and value is True:
            continue
        if name == "autoPause" and value is False:
            continue
        if (
            name == "autoResume"
            and isinstance(value, dict)
            and value.keys() == {"enabled"}
            and value["enabled"] is False
        ):
            continue
        return name
    return None


@router.post("/v2/sandboxes", status_code=201, response_model=None)
async def create_sandbox(
    request: Request,
    response: Response,
    req: CreateSandboxRequest = CreateSandboxRequest(),
) -> dict[str, str] | Response:
    unsupported = unsupported_create_option(req.model_extra or {})
    if "idempotency-key" in request.headers:
        unsupported = "Idempotency-Key"
    if unsupported is not None:
        return unsupported_lifecycle(
            f"sandbox create option is unsupported: {unsupported}"
        )
    if req.template != BASE_TEMPLATE:
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox template not found")
    try:
        config, written = await template_config(
            request, BASE_WORKSPACE_TEMPLATE
        )
    except HttpError as exc:
        if exc.code != ErrorCode.NOT_FOUND:
            raise
        logger.debug("using the built-in E2B base because %s", exc.message)
        written = {
            "mode": "read",
            "mounts": {"/home/user": {"vfs": "ram", "mode": "write"}},
            "env": {"HOME": "/home/user"},
        }
        config = check_config(written)
    entry = await open_workspace(
        request, response, new_workspace_id(), config, written, ephemeral=True
    )
    if request.app.state.registry.draining:
        await request.app.state.registry.remove(entry.id)
        raise HttpError(ErrorCode.SHUTTING_DOWN, "server is shutting down")
    sandboxes: Sandboxes = request.app.state.e2b
    return _present(sandboxes.add(entry, req.env_vars, req.timeout))


@router.post("/v2/sandboxes/{sandbox_id}/connect", response_model=None)
async def connect_sandbox(
    sandbox_id: str,
    request: Request,
    req: ConnectSandboxRequest = ConnectSandboxRequest(),
) -> dict[str, str] | Response:
    for name, value in (req.model_extra or {}).items():
        if name != "memory" or value is not True:
            return unsupported_lifecycle(
                f"sandbox connect option is unsupported: {name}"
            )
    sandboxes: Sandboxes = request.app.state.e2b
    lease = sandboxes.reconnect(sandbox_id, request.state.account, req.timeout)
    if lease is None:
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox not found")
    return _present(lease)


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


def failure(exc: Exception, *, connect: bool = False) -> JSONResponse:
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
    users = request.query_params.getlist("username")
    if users and users != ["user"]:
        raise FileError(
            "invalid_argument", "only the default sandbox user is supported"
        )
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


class DownloadResponse(StreamingResponse):
    def __init__(self, lease: Sandbox, path: str) -> None:
        self._lease = lease
        self._path = path
        self._source: AsyncIterator[bytes] | None = None
        super().__init__(
            self._output(),
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store"},
        )

    async def _open(self, files: SandboxFiles) -> None:
        self._source = await files.read(self._path)

    async def _output(self) -> AsyncIterator[bytes]:
        source = self._source
        assert source is not None

        while True:
            try:
                yield await self._lease.run_file(anext, source)
            except StopAsyncIteration:
                return

    async def stream_response(self, send: Send) -> None:
        lease = self._lease
        runner = lease.entry.runner
        started = False

        async def forward(message: Message) -> None:
            nonlocal started
            started = True
            await send(message)

        try:
            async with lease.file_access():
                try:
                    files = await _files_of(lease)
                    await lease.run_file(self._open, files)
                    await super().stream_response(forward)
                finally:
                    if self._source is not None:
                        with CancelScope(shield=True):
                            await runner.call(close_quietly(self._source))
        except Exception as exc:
            if not started:
                response = failure(exc)
                await forward(
                    {
                        "type": "http.response.start",
                        "status": response.status_code,
                        "headers": response.raw_headers,
                    }
                )
                await send(
                    {"type": "http.response.body", "body": response.body}
                )
            elif isinstance(exc, SandboxNotRunning):
                raise ConnectionError(
                    "sandbox closed during download"
                ) from exc
            else:
                raise


@data_router.get(FILES)
async def download(request: Request) -> Response:
    try:
        lease = require_sandbox(request)
        return DownloadResponse(lease, _query_path(request))
    except Exception as exc:
        return failure(exc)


@data_router.post(FILES)
async def upload(request: Request) -> Response:
    try:
        lease = require_sandbox(request)
        if any(name.startswith("x-metadata-") for name in request.headers):
            raise FileError("unimplemented", "file metadata is unsupported")
        path = _query_path(request)
        data = await lease.read_body(_multipart_file, request)
        lease = require_sandbox(request)
        async with lease.file_access():
            files = await _files_of(lease)
            written = await lease.run_file(files.write, path, data)
        return JSONResponse([written])
    except Exception as exc:
        return failure(exc)


def _rpc_endpoint(
    method: FileMethod,
) -> Callable[[Request], Awaitable[Response]]:
    async def endpoint(request: Request) -> Response:
        try:
            lease = require_sandbox(request)
            body = await lease.read_body(json_body, request)
            lease = require_sandbox(request)
            async with lease.file_access():
                files = await _files_of(lease)
                if method == "Move":
                    source, destination = (
                        body.get("source"),
                        body.get("destination"),
                    )
                    if not isinstance(source, str) or not isinstance(
                        destination, str
                    ):
                        raise FileError(
                            "invalid_argument",
                            "expected source and destination paths",
                        )
                    entry = await lease.run_file(
                        files.move, source, destination
                    )
                    return JSONResponse({"entry": entry})
                path = body.get("path")
                if not isinstance(path, str):
                    raise FileError("invalid_argument", "expected a file path")
                if method == "Stat":
                    return JSONResponse(
                        {"entry": await lease.run_file(files.stat, path)}
                    )
                if method == "ListDir":
                    depth = body.get("depth", 1)
                    if type(depth) is not int:
                        raise FileError(
                            "invalid_argument",
                            "list depth must be a positive uint32",
                        )
                    return JSONResponse(
                        {
                            "entries": await lease.run_file(
                                files.list_dir, path, depth
                            )
                        }
                    )
                if method == "MakeDir":
                    await lease.run_file(files.mkdir, path)
                else:
                    await lease.run_file(files.remove, path)
            return JSONResponse({})
        except Exception as exc:
            return failure(exc, connect=True)

    return endpoint


for method in METHODS:
    data_router.add_api_route(
        RPC_PREFIX + method, _rpc_endpoint(method), methods=["POST"]
    )


def unsupported_lifecycle(message: str) -> JSONResponse:
    return JSONResponse({"code": 501, "message": message}, status_code=501)


async def reject_lifecycle() -> JSONResponse:
    return unsupported_lifecycle(
        "E2B sandbox operation is unsupported by Mirage"
    )


async def reject_rpc(request: Request) -> JSONResponse:
    try:
        require_sandbox(request)
    except HttpError as exc:
        return failure(exc, connect=True)
    return failure(
        FileError(
            "unimplemented", "E2B data operation is unsupported by Mirage"
        ),
        connect=True,
    )


for verb, path in UNSUPPORTED_LIFECYCLE_ROUTES:
    router.add_api_route(path, reject_lifecycle, methods=[verb])

for path in UNSUPPORTED_RPC_PATHS:
    data_router.add_api_route(path, reject_rpc, methods=["POST"])
