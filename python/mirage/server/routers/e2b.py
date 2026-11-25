from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field, StrictStr
from starlette.routing import Match
from starlette.types import Scope

from mirage.server.e2b.leases import Sandbox, Sandboxes
from mirage.server.e2b.process import start_process
from mirage.server.e2b.routing import require_sandbox
from mirage.server.errors import INTERNAL_MESSAGE, ErrorCode, HttpError
from mirage.server.routers.e2b_files import file_router
from mirage.server.routers.workspaces import open_workspace, template_config
from mirage.utils.ids import new_workspace_id

DEFAULT_TIMEOUT = 300
ENVD_VERSION = "0.5.6"


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
data_router.include_router(file_router(require_sandbox))


class ConnectSandboxRequest(BaseModel):
    timeout: int = Field(
        default=DEFAULT_TIMEOUT, strict=True, gt=0, le=2**53 - 1
    )


class CreateSandboxRequest(ConnectSandboxRequest):
    template: str = Field(default="base", alias="templateID")
    env_vars: dict[str, StrictStr] = Field(
        default_factory=dict, alias="envVars"
    )


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
    template: str = request.app.state.e2b_template
    if req.template not in ("base", template):
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox template not found")
    config, written = await template_config(request, template)
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
    return _present(lease, request.app.state.e2b_template)


@router.delete("/sandboxes/{sandbox_id}", status_code=204)
async def kill_sandbox(sandbox_id: str, request: Request) -> Response:
    sandboxes: Sandboxes = request.app.state.e2b
    removed = await sandboxes.kill(sandbox_id, request.state.account)
    if removed is None:
        raise HttpError(ErrorCode.NOT_FOUND, "sandbox not found")
    if not removed:
        raise HttpError(ErrorCode.INTERNAL, INTERNAL_MESSAGE)
    return Response(status_code=204)
