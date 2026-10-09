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

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, JsonValue

from mirage.server.jobs import JobEntry

router = APIRouter(prefix="/v1/jobs")


class JobBrief(BaseModel):
    job_id: str
    workspace_id: str
    session_id: str
    command: str
    status: str
    cancel_requested: bool
    submitted_at: float
    started_at: float | None = None
    finished_at: float | None = None


class JobDetail(JobBrief):
    result: JsonValue = None
    error: str | None = None


class WaitRequest(BaseModel):
    timeout_s: float | None = None


class CancelResponse(BaseModel):
    job_id: str
    canceled: bool


def _to_brief(entry: JobEntry) -> JobBrief:
    return JobBrief(
        job_id=entry.id,
        workspace_id=entry.workspace_id,
        session_id=entry.session_id,
        command=entry.command,
        status=entry.status.value,
        cancel_requested=entry.cancel_requested,
        submitted_at=entry.submitted_at,
        started_at=entry.started_at,
        finished_at=entry.finished_at,
    )


def _to_detail(entry: JobEntry) -> JobDetail:
    return JobDetail(
        **_to_brief(entry).model_dump(),
        result=entry.result,
        error=entry.error,
    )


async def _require_job(request: Request, job_id: str) -> JobEntry:
    """The job, when its workspace is the caller's to reach.

    A job of another account's workspace, or of an earlier workspace
    under the same id, answers 404 like a missing one.

    Args:
        request (Request): the request.
        job_id (str): the job asked for.
    """
    table = request.app.state.jobs
    try:
        entry = table.get(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    registry = request.app.state.registry
    if not await registry.allows(
        entry.workspace_id, request.state.account, entry.submitted_at
    ):
        raise HTTPException(status_code=404, detail="job not found")
    return entry


@router.get("", response_model=list[JobBrief])
async def list_jobs(
    request: Request, workspace_id: str | None = Query(None)
) -> list[JobBrief]:
    registry = request.app.state.registry
    account = request.state.account
    return [
        _to_brief(j)
        for j in request.app.state.jobs.list(workspace_id=workspace_id)
        if await registry.allows(j.workspace_id, account, j.submitted_at)
    ]


@router.get("/{job_id}", response_model=JobDetail)
async def get_job(job_id: str, request: Request) -> JobDetail:
    return _to_detail(await _require_job(request, job_id))


@router.post("/{job_id}/wait", response_model=JobDetail)
async def wait_job(
    job_id: str, req: WaitRequest, request: Request
) -> JobDetail:
    await _require_job(request, job_id)
    table = request.app.state.jobs
    try:
        entry = await table.wait(job_id, timeout=req.timeout_s)
        return _to_detail(entry)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc


@router.delete("/{job_id}", response_model=CancelResponse)
async def cancel_job(job_id: str, request: Request) -> CancelResponse:
    await _require_job(request, job_id)
    table = request.app.state.jobs
    try:
        canceled = table.cancel(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="job not found") from exc
    return CancelResponse(job_id=job_id, canceled=canceled)
