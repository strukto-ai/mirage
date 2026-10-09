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

import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from mirage.policy.errors import PolicyError
from mirage.server.schemas import CancelLinesResponse, KillJobsResponse

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/sessions")


class CreateSessionRequest(BaseModel):
    session_id: str | None = None
    # A mapping of prefix to mode, never a bare list: a list of prefixes
    # used to mean "only these mounts" and now means nothing at all, so
    # it is refused here rather than accepted as a no-op that reads like
    # confinement.
    mounts: dict[str, str] | None = None
    profile: str | None = None


class SessionResponse(BaseModel):
    session_id: str
    cwd: str


class DeleteSessionResponse(BaseModel):
    session_id: str


async def _require_session(entry, session_id: str) -> None:
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    if not any(
        s.session_id == session_id for s in entry.runner.ws.list_sessions()
    ):
        raise HTTPException(status_code=404, detail="session not found")


def _require_entry(request: Request, workspace_id: str):
    entry = request.app.state.registry.visible(
        workspace_id, request.state.account
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return entry


@router.post("", response_model=SessionResponse, status_code=201)
async def create_session(
    workspace_id: str, req: CreateSessionRequest, request: Request
) -> SessionResponse:
    entry = _require_entry(request, workspace_id)
    sid = req.session_id or f"sess_{secrets.token_hex(6)}"
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    if any(s.session_id == sid for s in entry.runner.ws.list_sessions()):
        raise HTTPException(
            status_code=409, detail=f"session id already exists: {sid!r}"
        )
    try:
        sess = entry.runner.ws.create_session(
            sid, mounts=req.mounts or None, profile=req.profile
        )
    except (ValueError, PolicyError) as exc:
        # An unknown profile name and a refused inline document are
        # both the caller's mistake, and PolicyError is not a
        # ValueError, so naming it here is what keeps them 422 rather
        # than 500.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await entry.runner.call(entry.runner.ws.flush_sessions())
    return SessionResponse(session_id=sess.session_id, cwd=sess.cwd)


@router.get("", response_model=list[SessionResponse])
async def list_sessions(
    workspace_id: str, request: Request
) -> list[SessionResponse]:
    entry = _require_entry(request, workspace_id)
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    return [
        SessionResponse(session_id=s.session_id, cwd=s.cwd)
        for s in entry.runner.ws.list_sessions()
    ]


@router.delete("/{session_id}", response_model=DeleteSessionResponse)
async def delete_session(
    workspace_id: str, session_id: str, request: Request
) -> DeleteSessionResponse:
    entry = _require_entry(request, workspace_id)
    await _require_session(entry, session_id)
    await entry.runner.call(entry.runner.ws.close_session(session_id))
    return DeleteSessionResponse(session_id=session_id)


@router.post("/{session_id}/cancel", response_model=CancelLinesResponse)
async def cancel_session_lines(
    workspace_id: str, session_id: str, request: Request
) -> CancelLinesResponse:
    """Cancel the session's running and queued lines, from every entry point.

    The session stays open; returns once those lines have ended.
    """
    entry = _require_entry(request, workspace_id)
    await _require_session(entry, session_id)
    canceled = await entry.runner.call(entry.runner.ws.cancel(session_id))
    return CancelLinesResponse(canceled=canceled)


@router.post("/{session_id}/kill", response_model=KillJobsResponse)
async def kill_session_jobs(
    workspace_id: str, session_id: str, request: Request
) -> KillJobsResponse:
    """Kill the session's background jobs and runners; it stays open."""
    entry = _require_entry(request, workspace_id)
    await _require_session(entry, session_id)
    killed = await entry.runner.call(entry.runner.ws.kill(session_id))
    return KillJobsResponse(killed=killed)


class UpdateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    profile: str | None


@router.patch("/{session_id}", response_model=SessionResponse)
async def update_session(
    workspace_id: str,
    session_id: str,
    req: UpdateSessionRequest,
    request: Request,
) -> SessionResponse:
    """Replace the session's profile; its cwd, env and history stay."""
    entry = _require_entry(request, workspace_id)
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    try:
        sess = await entry.runner.call(
            entry.runner.ws.set_session_profile(session_id, req.profile)
        )
    except KeyError as exc:
        raise HTTPException(404, "session not found") from exc
    except (ValueError, PolicyError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return SessionResponse(session_id=sess.session_id, cwd=sess.cwd)
