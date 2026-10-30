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

import os
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from mirage.server.metrics import CONTENT_TYPE, render_metrics
from mirage.server.schemas import HealthResponse

router = APIRouter()


class ShutdownResponse(BaseModel):
    status: str
    pid: int


@router.get("/v1/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    started_at = request.app.state.started_at
    return HealthResponse(
        status="ok",
        workspaces=len(request.app.state.registry),
        uptime_s=round(time.time() - started_at, 3),
    )


@router.get("/v1/ready")
async def ready(request: Request) -> JSONResponse:
    """Whether the server takes new workspaces: 503 while it drains for
    shutdown or holds ``max_workspaces``, so a load balancer sends new
    work elsewhere. ``/v1/health`` only says the process is up.
    """
    registry = request.app.state.registry
    status = "ready"
    if registry.draining:
        status = "draining"
    elif (
        registry.max_workspaces is not None
        and len(registry) >= registry.max_workspaces
    ):
        status = "full"
    return JSONResponse(
        {"status": status}, status_code=200 if status == "ready" else 503
    )


@router.get("/v1/metrics")
async def metrics(request: Request) -> Response:
    """The server's metrics, in Prometheus's text format."""
    state = request.app.state
    return Response(
        content=render_metrics(
            state.registry,
            state.jobs,
            time.time() - state.started_at,
            state.responses,
        ),
        media_type=CONTENT_TYPE,
    )


@router.post("/v1/shutdown", response_model=ShutdownResponse)
async def shutdown(request: Request) -> ShutdownResponse:
    """Trip the exit event, which the app's ``on_idle_exit`` acts on.

    The daemon's hook sends SIGTERM to its own process, so uvicorn runs
    its graceful shutdown (close connections, run the lifespan's finally
    block). An app run without a hook keeps serving. The server serves
    every account, so an account may not stop it.
    """
    if request.state.account is not None:
        raise HTTPException(
            status_code=403, detail="an account may not shut the server down"
        )
    request.app.state.exit_event.set()
    return ShutdownResponse(status="shutting_down", pid=os.getpid())
