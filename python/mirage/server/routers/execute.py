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

import asyncio
import functools
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel

from mirage.server.io_serde import io_result_to_dict
from mirage.server.jobs import JobEntry, JobStatus

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/execute")


class ExecuteRequest(BaseModel):
    command: str
    session_id: str | None = None
    provision: bool = False
    agent_id: str | None = None


class BackgroundResponse(BaseModel):
    job_id: str
    workspace_id: str
    submitted_at: float


def _require_entry(request: Request, workspace_id: str):
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    return registry.get(workspace_id)


def _build_execute_kwargs(req: ExecuteRequest,
                          stdin: bytes | None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "command": req.command,
        "provision": req.provision,
    }
    if req.session_id is not None:
        kwargs["session_id"] = req.session_id
    if req.agent_id is not None:
        kwargs["agent_id"] = req.agent_id
    if stdin is not None:
        kwargs["stdin"] = stdin
    return kwargs


def _make_coro_factory(runner, kwargs: dict[str, Any]):
    return functools.partial(_invoke_execute, runner, kwargs)


async def _invoke_execute(runner, kwargs: dict[str, Any]):
    return await runner.ws.execute(**kwargs)


def _schedule_on_runner(runner, coro):
    return asyncio.run_coroutine_threadsafe(coro, runner.loop)


def _job_to_dict(entry: JobEntry,
                 result_dict: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "job_id": entry.id,
        "workspace_id": entry.workspace_id,
        "command": entry.command,
        "status": entry.status.value,
        "submitted_at": entry.submitted_at,
        "started_at": entry.started_at,
        "finished_at": entry.finished_at,
        "result": result_dict,
        "error": entry.error,
    }


@router.post("")
async def execute(
        workspace_id: str,
        request: Request,
        background: bool = Query(False),
) -> Response:
    entry = _require_entry(request, workspace_id)
    job_table = request.app.state.jobs
    content_type = request.headers.get("content-type", "")
    req_obj, stdin_bytes = await _parse_execute_body(request, content_type)
    schedule = functools.partial(_schedule_on_runner, entry.runner)
    job = job_table.submit(
        workspace_id=workspace_id,
        command=req_obj.command,
        schedule=schedule,
        coro_factory=_make_coro_factory(
            entry.runner,
            _build_execute_kwargs(req_obj, stdin_bytes),
        ),
    )
    if background:
        return Response(
            content=BackgroundResponse(
                job_id=job.id,
                workspace_id=workspace_id,
                submitted_at=job.submitted_at,
            ).model_dump_json(),
            media_type="application/json",
            status_code=202,
            headers={"X-Mirage-Job-Id": job.id},
        )
    await job_table.wait(job.id)
    if job.status == JobStatus.CANCELED:
        raise HTTPException(status_code=499, detail="job canceled")
    if job.status == JobStatus.FAILED:
        raise HTTPException(status_code=500,
                            detail=job.error or "execute failed")
    result_dict = await io_result_to_dict(job.result)
    return Response(
        content=json.dumps(result_dict),
        media_type="application/json",
        status_code=200,
        headers={"X-Mirage-Job-Id": job.id},
    )


async def _parse_execute_body(
        request: Request,
        content_type: str) -> tuple[ExecuteRequest, bytes | None]:
    if content_type.startswith("multipart/"):
        form = await request.form()
        request_part = form.get("request")
        if request_part is None:
            raise HTTPException(status_code=400,
                                detail="multipart body missing 'request' part")
        if hasattr(request_part, "read"):
            req_text = (await request_part.read()).decode("utf-8")
        else:
            req_text = str(request_part)
        try:
            req_obj = ExecuteRequest.model_validate(json.loads(req_text))
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400,
                                detail=f"bad request part: {e}")
        stdin_part = form.get("stdin")
        stdin_bytes: bytes | None = None
        if stdin_part is not None:
            if hasattr(stdin_part, "read"):
                stdin_bytes = await stdin_part.read()
            else:
                stdin_bytes = str(stdin_part).encode("utf-8")
        return req_obj, stdin_bytes
    body = await request.json()
    return ExecuteRequest.model_validate(body), None
