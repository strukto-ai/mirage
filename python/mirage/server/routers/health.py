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
from pydantic import BaseModel

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
