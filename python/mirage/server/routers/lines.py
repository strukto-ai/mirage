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

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from mirage.execution.line.types import Line, LineState
from mirage.execution.types import LineId
from mirage.server.routers.vfs import require_entry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/lines")


class LineResponse(BaseModel):
    id: str
    session_id: str
    command: str
    state: str
    started_at: float
    ended_at: float | None
    exit: int | None
    signal: int | None
    error: str | None


class LineDetailResponse(LineResponse):
    jobs: list[str]
    processes: list[int]


def _to_response(record: Line) -> LineResponse:
    return LineResponse(
        id=str(record.id),
        session_id=record.session_id,
        command=record.command,
        state=record.state.value,
        started_at=record.started_at,
        ended_at=record.ended_at,
        exit=record.exit,
        signal=record.signal,
        error=record.error,
    )


@router.get("", response_model=list[LineResponse])
async def list_lines(
    workspace_id: str,
    request: Request,
    session_id: str | None = None,
    state: LineState | None = None,
) -> list[LineResponse]:
    """The lines the workspace keeps, oldest first: every one not ended
    yet and the newest ended ones, a session's or those in a state when
    named."""
    ws = require_entry(request, workspace_id).runner.ws
    return [_to_response(r) for r in ws.lines(session_id or None, state)]


@router.get("/{line_id}", response_model=LineDetailResponse)
async def get_line(
    workspace_id: str, line_id: str, request: Request
) -> LineDetailResponse:
    """One line, with the ids of the jobs it started and the pids of the
    processes it ran."""
    ws = require_entry(request, workspace_id).runner.ws
    record = ws.line(LineId(line_id))
    if record is None:
        raise HTTPException(status_code=404, detail="line not found")
    return LineDetailResponse(
        **_to_response(record).model_dump(),
        jobs=[job.id.console for job in ws.jobs() if job.line == record.id],
        processes=[process.pid for process in ws.processes(line_id=record.id)],
    )
