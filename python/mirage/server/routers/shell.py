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
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict

from mirage.io.types import ByteSource
from mirage.server.io_serde import io_result_to_dict
from mirage.server.jobs import JobEntry, JobStatus, JobTable
from mirage.server.multipart import MAX_REQUEST_PART, PartEvent, part_events
from mirage.server.registry import WorkspaceEntry
from mirage.server.stdin import LoopStdin, UploadStdin
from mirage.types import JsonValue
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.workspace import Workspace

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/shell")


class ShellRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command: str
    session_id: str | None = None
    agent_id: str | None = None
    cwd: str | None = None
    runtime: str | None = None
    record: bool = True


class BackgroundResponse(BaseModel):
    job_id: str
    workspace_id: str
    submitted_at: float


def _require_entry(request: Request, workspace_id: str) -> WorkspaceEntry:
    entry = request.app.state.registry.visible(
        workspace_id, request.state.account
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return entry


def _build_shell_kwargs(
    req: ShellRequest, stdin: ByteSource | None
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "command": req.command,
        "record": req.record,
    }
    if req.session_id is not None:
        kwargs["session_id"] = req.session_id
    if req.agent_id is not None:
        kwargs["agent_id"] = req.agent_id
    if req.cwd is not None:
        kwargs["cwd"] = req.cwd
    if req.runtime is not None:
        kwargs["runtime"] = req.runtime
    if stdin is not None:
        kwargs["stdin"] = stdin
    return kwargs


async def _invoke_shell(
    ws: Workspace, kwargs: dict[str, Any], scope: ExecutionScope
) -> JsonValue:
    result = await ws.shell(**kwargs, execution_scope=scope)
    return await io_result_to_dict(result)


@router.post("")
async def shell(
    workspace_id: str,
    request: Request,
    background: bool = Query(False),
) -> Response:
    entry = _require_entry(request, workspace_id)
    job_table = request.app.state.jobs
    content_type = request.headers.get("content-type", "")
    upload: asyncio.Task[None] | None = None
    part: UploadStdin | None = None
    stdin: ByteSource | None = None
    if content_type.startswith("multipart/"):
        started: asyncio.Future[tuple[ShellRequest, UploadStdin | None]] = (
            asyncio.get_running_loop().create_future()
        )
        upload = asyncio.ensure_future(
            _read_shell_body(request, content_type, started, UploadStdin())
        )
        req_obj, part = await started
        if part is not None and background:
            stdin = await _read_all(part)
        elif part is not None:
            stdin = LoopStdin(part, asyncio.get_running_loop())
    else:
        req_obj = await _parse_json_body(request)
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    kwargs = _build_shell_kwargs(req_obj, stdin)
    session_id = (
        req_obj.session_id
        if req_obj.session_id is not None
        else entry.runner.ws.default_session_id
    )
    kwargs["session_id"] = session_id

    async def run(scope: ExecutionScope) -> JsonValue:
        return await entry.runner.call(
            _invoke_shell(entry.runner.ws, kwargs, scope)
        )

    if background and upload is not None:
        await upload
    job = await job_table.submit(
        workspace_id=workspace_id,
        command=req_obj.command,
        factory=run,
        session_id=session_id,
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
    job = await wait_attended(job_table, job.id, request, upload)
    if upload is not None:
        await _finish_upload(upload, part)
    if job.status == JobStatus.CANCELED:
        raise HTTPException(status_code=499, detail="job canceled")
    if job.status == JobStatus.FAILED:
        raise HTTPException(
            status_code=500, detail=job.error or "shell failed"
        )
    return Response(
        content=json.dumps(job.result),
        media_type="application/json",
        status_code=200,
        headers={"X-Mirage-Job-Id": job.id},
    )


async def wait_attended(
    job_table: JobTable,
    job_id: str,
    request: Request,
    upload: asyncio.Task[None] | None = None,
) -> JobEntry:
    """Wait for a foreground job while its caller stays connected.

    A caller that drops the request is gone for good, so its job is
    cancelled, as the line would be if the caller had pressed Ctrl-C.
    While a streamed upload is still arriving, its reader is the one
    that sees the caller go; an upload that fails, the caller gone or
    the body bad, cancels the job the same way.

    Args:
        job_table (JobTable): the daemon's job table.
        job_id (str): the job the request submitted.
        request (Request): the request waiting on it.
        upload (asyncio.Task[None] | None): the task still reading the
            request body, if any.

    Returns:
        JobEntry: the settled job.
    """

    async def caller_gone() -> None:
        if upload is not None:
            try:
                await asyncio.shield(upload)
            except Exception as exc:
                logger.debug("shell upload ended early: %r", exc)
                return
        while (await request.receive())["type"] != "http.disconnect":
            pass

    waiter = asyncio.ensure_future(job_table.wait(job_id))
    gone = asyncio.ensure_future(caller_gone())
    try:
        await asyncio.wait({waiter, gone}, return_when=asyncio.FIRST_COMPLETED)
        if gone.done() and not waiter.done():
            await job_table.cancel(job_id)
        return await waiter
    finally:
        gone.cancel()


async def _finish_upload(
    upload: asyncio.Task[None], part: UploadStdin | None
) -> None:
    if part is not None:
        part.discard()
    try:
        await upload
    except HTTPException:
        raise
    except Exception as exc:
        logger.debug("shell upload ended early: %r", exc)


async def _read_all(part: UploadStdin) -> bytes:
    chunks: list[bytes] = []
    while data := await part.read():
        chunks.append(data)
    return b"".join(chunks)


async def _read_shell_body(
    request: Request,
    content_type: str,
    started: asyncio.Future[tuple[ShellRequest, UploadStdin | None]],
    stdin: UploadStdin,
) -> None:
    """Read a multipart shell body as it arrives.

    The ``request`` part comes first. ``started`` resolves with it as
    soon as the ``stdin`` part begins, or the body ends without one, so
    the line can start while its stdin is still uploading; the stdin
    part's chunks then go to ``stdin`` as they arrive.

    Args:
        request (Request): the shell request.
        content_type (str): its ``Content-Type`` header.
        started (asyncio.Future): resolves with the parsed request and
            the stdin, or ``None`` without a stdin part; fails with the
            reason a body is refused before the line starts.
        stdin (UploadStdin): where the stdin part's chunks go.

    Raises:
        Exception: the body failing after the line has started, such as
            the caller dropping the request; the line's stdin then ends.
    """
    try:
        name = b""
        body = bytearray()
        req_obj: ShellRequest | None = None
        async for event, data in part_events(request.stream(), content_type):
            if event is PartEvent.BEGIN:
                name = data
                if name != b"stdin":
                    continue
                if req_obj is None:
                    raise HTTPException(
                        status_code=400,
                        detail="the 'request' part must come before 'stdin'",
                    )
                started.set_result((req_obj, stdin))
            elif event is PartEvent.DATA and name == b"request":
                body += data
                if len(body) > MAX_REQUEST_PART:
                    raise HTTPException(
                        status_code=413, detail="request part too large"
                    )
            elif event is PartEvent.DATA and name == b"stdin":
                await stdin.feed(data)
            elif event is PartEvent.END and name == b"request":
                req_obj = _parse_request_part(bytes(body))
            elif event is PartEvent.END and name == b"stdin":
                await stdin.close()
    except Exception as exc:
        if started.done():
            stdin.discard()
            raise
        started.set_exception(exc)
        return
    if started.done():
        return
    if req_obj is None:
        started.set_exception(
            HTTPException(
                status_code=400, detail="multipart body missing 'request' part"
            )
        )
        return
    started.set_result((req_obj, None))


def _parse_request_part(body: bytes) -> ShellRequest:
    try:
        return ShellRequest.model_validate(json.loads(body))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"bad request part: {e}")


async def _parse_json_body(request: Request) -> ShellRequest:
    try:
        return ShellRequest.model_validate(await request.json())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"bad shell request: {e}")
