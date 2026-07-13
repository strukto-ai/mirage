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

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/sessions")


class CreateSessionRequest(BaseModel):
    session_id: str | None = None
    mounts: dict[str, str] | list[str] | None = None


class SessionResponse(BaseModel):
    session_id: str
    cwd: str


class DeleteSessionResponse(BaseModel):
    session_id: str


def _require_entry(request: Request, workspace_id: str):
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    return registry.get(workspace_id)


@router.post("", response_model=SessionResponse, status_code=201)
async def create_session(workspace_id: str, req: CreateSessionRequest,
                         request: Request) -> SessionResponse:
    import secrets
    entry = _require_entry(request, workspace_id)
    sid = req.session_id or f"sess_{secrets.token_hex(6)}"
    if any(s.session_id == sid for s in entry.runner.ws.list_sessions()):
        raise HTTPException(status_code=409,
                            detail=f"session id already exists: {sid!r}")
    try:
        sess = entry.runner.ws.create_session(sid, mounts=req.mounts or None)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SessionResponse(session_id=sess.session_id, cwd=sess.cwd)


@router.get("", response_model=list[SessionResponse])
async def list_sessions(workspace_id: str,
                        request: Request) -> list[SessionResponse]:
    entry = _require_entry(request, workspace_id)
    return [
        SessionResponse(session_id=s.session_id, cwd=s.cwd)
        for s in entry.runner.ws.list_sessions()
    ]


@router.delete("/{session_id}", response_model=DeleteSessionResponse)
async def delete_session(workspace_id: str, session_id: str,
                         request: Request) -> DeleteSessionResponse:
    entry = _require_entry(request, workspace_id)
    if not any(s.session_id == session_id
               for s in entry.runner.ws.list_sessions()):
        raise HTTPException(status_code=404, detail="session not found")
    await entry.runner.call(entry.runner.ws.close_session(session_id))
    return DeleteSessionResponse(session_id=session_id)
