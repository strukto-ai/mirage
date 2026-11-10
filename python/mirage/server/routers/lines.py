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

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from mirage.execution.line.types import Line, LineState
from mirage.execution.types import LineId
from mirage.io.errors import PipeClosed
from mirage.io.pipe import BytePipe
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.requests import RequestTable
from mirage.server.routers.vfs import require_entry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/lines")

NOT_OPEN = "the line's stdin is not open"


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
    machines: list[str]


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
    named. Read on the workspace's own loop."""
    runner = require_entry(request, workspace_id).runner

    async def read() -> list[LineResponse]:
        records = await runner.ws.lines(session_id or None, state)
        return [_to_response(r) for r in records]

    return await runner.call(read())


@router.get("/{line_id}", response_model=LineDetailResponse)
async def get_line(
    workspace_id: str, line_id: str, request: Request
) -> LineDetailResponse:
    """One line, with the ids of the jobs it started, the pids of the
    processes it ran that the workspace still keeps and the machines
    those ran on. Read on the workspace's own loop."""
    runner = require_entry(request, workspace_id).runner

    async def read() -> LineDetailResponse | None:
        ws = runner.ws
        record = await ws.line(LineId(line_id))
        if record is None:
            return None
        processes = await ws.processes(line_id=record.id)
        return LineDetailResponse(
            **_to_response(record).model_dump(),
            jobs=[job.id.console for job in await ws.jobs(line_id=record.id)],
            processes=[p.pid for p in processes],
            machines=list(dict.fromkeys(str(p.machine) for p in processes)),
        )

    detail = await runner.call(read())
    if detail is None:
        raise HttpError(ErrorCode.NOT_FOUND, "line not found")
    return detail


def _open_stdin(request: Request, workspace_id: str, line_id: str) -> BytePipe:
    """A running line's open stdin.

    Args:
        request (Request): the request, for the app's job table.
        workspace_id (str): the workspace.
        line_id (str): the line.

    Raises:
        HttpError: 404 when no such line is running there, 409 when
            it did not open its stdin.
    """
    jobs: RequestTable = request.app.state.jobs
    job = jobs.get(LineId(line_id))
    if job is None or job.workspace_id != workspace_id:
        raise HttpError(ErrorCode.NOT_FOUND, "line not found")
    if job.stdin is None:
        raise HttpError(ErrorCode.CONFLICT, NOT_OPEN)
    return job.stdin


@router.post("/{line_id}/stdin", status_code=204, response_model=None)
async def write_stdin(
    workspace_id: str, line_id: str, request: Request
) -> Response:
    """Send the body to a running line's open stdin. It answers once the
    bytes are buffered, so a line that stops reading holds its writer
    back; a caller that hangs up while held takes its bytes with it.
    Runs on the workspace's own loop, where the line reads."""
    runner = require_entry(request, workspace_id).runner
    stdin = _open_stdin(request, workspace_id, line_id)
    arrival = asyncio.ensure_future(request.receive())
    try:
        more = True
        while more:
            message = await arrival
            if message["type"] == "http.disconnect":
                return Response(status_code=499)
            more = message.get("more_body", False)
            arrival = asyncio.ensure_future(request.receive())
            writing = asyncio.ensure_future(
                runner.call(stdin.write(message.get("body", b"")))
            )
            await asyncio.wait(
                {writing, arrival}, return_when=asyncio.FIRST_COMPLETED
            )
            if (
                not writing.done()
                and arrival.result()["type"] == "http.disconnect"
            ):
                writing.cancel()
                await asyncio.gather(writing, return_exceptions=True)
                return Response(status_code=499)
            await writing
    except PipeClosed as exc:
        raise HttpError(ErrorCode.CONFLICT, NOT_OPEN) from exc
    finally:
        arrival.cancel()
    return Response(status_code=204)


@router.delete("/{line_id}/stdin", status_code=204, response_model=None)
async def close_stdin(
    workspace_id: str, line_id: str, request: Request
) -> Response:
    """End a running line's open stdin: the line reads what was sent,
    then end of file."""
    runner = require_entry(request, workspace_id).runner
    stdin = _open_stdin(request, workspace_id, line_id)
    runner.loop.call_soon_threadsafe(stdin.end)
    return Response(status_code=204)
