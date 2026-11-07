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

from mirage.execution.process.types import Process, ProcessState
from mirage.execution.types import LineId, ProcessId
from mirage.server.routers.vfs import require_entry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/processes")


class ProcessResponse(BaseModel):
    pid: int
    session_id: str
    line_id: str | None
    parent: int | None
    group: int
    command: str
    cwd: str
    machine: str
    runtime: str | None
    machine_pid: int | None
    state: str
    started_at: float
    ended_at: float | None
    exit: int | None
    signal: int | None
    error: str | None


def _to_response(record: Process) -> ProcessResponse:
    return ProcessResponse(
        pid=record.pid,
        session_id=record.session_id,
        line_id=str(record.line) if record.line is not None else None,
        parent=record.parent,
        group=record.group,
        command=record.command,
        cwd=record.cwd.virtual,
        machine=str(record.machine),
        runtime=record.runtime,
        machine_pid=(
            record.machine_pid.pid if record.machine_pid is not None else None
        ),
        state=record.state.value,
        started_at=record.started_at,
        ended_at=record.ended_at,
        exit=record.exit,
        signal=record.signal,
        error=record.error,
    )


@router.get("", response_model=list[ProcessResponse])
async def list_processes(
    workspace_id: str,
    request: Request,
    session_id: str | None = None,
    state: ProcessState | None = None,
    line_id: str | None = None,
) -> list[ProcessResponse]:
    """The processes the workspace keeps, by pid: every live one and the
    newest ended ones, a session's, those in a state or those a line ran
    when named."""
    ws = require_entry(request, workspace_id).runner.ws
    records = ws.processes(
        session_id or None, state, LineId(line_id) if line_id else None
    )
    return [_to_response(r) for r in records]


@router.get("/{pid}", response_model=ProcessResponse)
async def get_process(
    workspace_id: str, pid: int, request: Request
) -> ProcessResponse:
    """One process, by its pid."""
    ws = require_entry(request, workspace_id).runner.ws
    record = ws.process(ProcessId(ws.workspace_id, pid))
    if record is None:
        raise HTTPException(status_code=404, detail="process not found")
    return _to_response(record)
