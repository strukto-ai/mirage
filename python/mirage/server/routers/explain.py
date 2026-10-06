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


from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from mirage.server.io_serde import explanation_to_dict
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/explain")


class ExplainShellRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command: str
    session_id: str | None = None


def _require_entry(request: Request, workspace_id: str) -> WorkspaceEntry:
    registry: WorkspaceRegistry = request.app.state.registry
    entry = registry.visible(workspace_id, request.state.account)
    if entry is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return entry


@router.post("/shell")
async def explain_shell(
    workspace_id: str, req: ExplainShellRequest, request: Request
) -> dict[str, Any]:
    """What a line would do as a session, without running any of it:
    ``session.explain.shell``, the dry run of ``POST /shell``."""
    entry = _require_entry(request, workspace_id)
    ws = entry.runner.ws
    await entry.runner.call(ws.ensure_sessions_loaded())
    if req.session_id and not any(
        s.session_id == req.session_id for s in ws.list_sessions()
    ):
        raise HTTPException(status_code=404, detail="session not found")
    said = await entry.runner.call(
        ws.explain(req.command, req.session_id or "")
    )
    return explanation_to_dict(said)
