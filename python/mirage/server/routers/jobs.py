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

from mirage.execution.job import Job, JobState
from mirage.execution.types import JobId
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
    state: str
    started_at: float
    ended_at: float | None
    exit: int | None
    signal: int | None


def _to_response(record: Job) -> JobResponse:
    return JobResponse(
        id=record.id.console,
        number=record.number,
        session_id=record.session_id,
        command=record.command,
        cwd=record.cwd,
        line_id=str(record.line) if record.line is not None else None,
        group=record.group,
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
) -> list[JobResponse]:
    """The jobs the workspace's sessions list, as ``jobs`` does, a
    session's or those in a state when named."""
    ws = require_entry(request, workspace_id).runner.ws
    return [_to_response(r) for r in ws.jobs(session_id or None, state)]


@router.get("/{job_id}", response_model=JobResponse)
async def get_job(
    workspace_id: str, job_id: str, request: Request
) -> JobResponse:
    """One job, named by the id its listing gives."""
    ws = require_entry(request, workspace_id).runner.ws
    record = ws.job(JobId(ws.workspace_id, job_id))
    if record is None:
        raise HTTPException(status_code=404, detail="job not found")
    return _to_response(record)
