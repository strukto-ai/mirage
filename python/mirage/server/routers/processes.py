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

from fastapi import APIRouter, Request
from pydantic import BaseModel

from mirage.execution.process.types import Process, ProcessState
from mirage.execution.types import JobId, LineId, MachineId, ProcessId
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.routers.vfs import require_entry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/processes")


class MachinePidResponse(BaseModel):
    pid: int
    started: float
    exited: float | None


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
    machine_pid: MachinePidResponse | None
    state: str
    started_at: float
    ended_at: float | None
    exit: int | None
    signal: int | None
    error: str | None


def to_response(record: Process) -> ProcessResponse:
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
            MachinePidResponse(
                pid=record.machine_pid.pid,
                started=record.machine_pid.started,
                exited=record.machine_pid.exited,
            )
            if record.machine_pid is not None
            else None
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
    job_id: str | None = None,
    machine: str | None = None,
) -> list[ProcessResponse]:
    """The processes the workspace keeps, by pid: every live one and the
    newest ended ones, a session's, those in a state, those a line ran,
    those a job ran or those run on a machine (``provider:name``) when
    named. Read on the workspace's own loop."""
    runner = require_entry(request, workspace_id).runner
    line = LineId(line_id) if line_id else None
    job = JobId(runner.ws.workspace_id, job_id) if job_id else None
    try:
        where = MachineId.parse(machine) if machine else None
    except ValueError as exc:
        raise HttpError(
            ErrorCode.INVALID_VALUE,
            "machine must be provider:name",
            param="machine",
        ) from exc

    async def read() -> list[ProcessResponse]:
        records = await runner.ws.processes(
            session_id or None, state, line, job, where
        )
        return [to_response(r) for r in records]

    return await runner.call(read())


@router.get("/{pid}", response_model=ProcessResponse)
async def get_process(
    workspace_id: str, pid: int, request: Request
) -> ProcessResponse:
    """One process, by its pid. Read on the workspace's own loop."""
    runner = require_entry(request, workspace_id).runner

    async def read() -> Process | None:
        return await runner.ws.process(ProcessId(runner.ws.workspace_id, pid))

    record = await runner.call(read())
    if record is None:
        raise HttpError(ErrorCode.NOT_FOUND, "process not found")
    return to_response(record)
