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

from mirage.execution.job import Job, JobState
from mirage.execution.types import JobId, LineId
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.routers.vfs import require_entry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/jobs")


class JobResponse(BaseModel):
    id: str
    number: int
    session_id: str
    command: str
    cwd: str
    line_id: str | None
    group: int | None
    pid: int | None
    state: str
    started_at: float
    ended_at: float | None
    exit: int | None
    signal: int | None


class JobDetailResponse(JobResponse):
    processes: list[int]


def _to_response(record: Job) -> JobResponse:
    return JobResponse(
        id=record.id.console,
        number=record.number,
        session_id=record.session_id,
        command=record.command,
        cwd=record.cwd,
        line_id=str(record.line) if record.line is not None else None,
        group=record.group,
        pid=record.pid,
        state=record.state.value,
        started_at=record.started_at,
        ended_at=record.ended_at,
        exit=record.exit,
        signal=record.signal,
    )


@router.get("", response_model=list[JobResponse])
async def list_jobs(
    workspace_id: str,
    request: Request,
    session_id: str | None = None,
    state: JobState | None = None,
    line_id: str | None = None,
) -> list[JobResponse]:
    """The jobs the workspace's sessions list, as ``jobs`` does, a
    session's, those in a state or those a line started when named.
    Read on the workspace's own loop."""
    runner = require_entry(request, workspace_id).runner
    line = LineId(line_id) if line_id else None

    async def read() -> list[JobResponse]:
        records = await runner.ws.jobs(session_id or None, state, line)
        return [_to_response(r) for r in records]

    return await runner.call(read())


@router.get("/{job_id}", response_model=JobDetailResponse)
async def get_job(
    workspace_id: str, job_id: str, request: Request
) -> JobDetailResponse:
    """One job, named by the id its listing gives, with the pids of the
    processes it ran that the workspace still keeps: its own and every
    one under it. Read on the workspace's own loop."""
    runner = require_entry(request, workspace_id).runner

    async def read() -> JobDetailResponse | None:
        ws = runner.ws
        record = await ws.job(JobId(ws.workspace_id, job_id))
        if record is None:
            return None
        return JobDetailResponse(
            **_to_response(record).model_dump(),
            processes=[p.pid for p in await ws.processes(job_id=record.id)],
        )

    detail = await runner.call(read())
    if detail is None:
        raise HttpError(ErrorCode.NOT_FOUND, "job not found")
    return detail
