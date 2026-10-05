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

import dataclasses
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from mirage.policy.types import Decision, Outcome, Scope
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry

router = APIRouter(prefix="/v1/workspaces/{workspace_id}/asks")


class AskResponse(BaseModel):
    id: str
    session_id: str
    agent_id: str
    command: str
    argv: list[str]
    cwd: str
    paths: list[str]
    reason: str
    outcome: str | None
    scope: str
    note: str


class AnswerAskRequest(BaseModel):
    answer: Literal["allow", "deny"]
    scope: Literal["once", "session"] = "once"
    note: str = ""


def _require_entry(request: Request, workspace_id: str) -> WorkspaceEntry:
    registry: WorkspaceRegistry = request.app.state.registry
    entry = registry.visible(workspace_id, request.state.account)
    if entry is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return entry


def _to_response(record: Decision) -> AskResponse:
    return AskResponse(
        id=record.id,
        session_id=record.session_id,
        agent_id=record.agent_id,
        command=record.command,
        argv=list(record.argv),
        cwd=record.cwd,
        paths=list(record.paths),
        reason=record.reason,
        outcome=record.outcome.value if record.outcome is not None else None,
        scope=record.scope.value,
        note=record.note,
    )


@router.get("", response_model=list[AskResponse])
async def list_asks(
    workspace_id: str,
    request: Request,
    session_id: str = "",
    include_settled: bool = Query(False, alias="all"),
) -> list[AskResponse]:
    """The workspace's asks: pending by default, every decision under
    ``all=true``. The ledger already serves both views from one store,
    so the door only picks which query to run."""
    entry = _require_entry(request, workspace_id)
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    # The ledger reads a named session through SessionManager.get, which
    # raises for an unknown id; a mistyped filter is the caller's error,
    # answered in the sessions router's voice rather than as a 500.
    if session_id and not any(
        s.session_id == session_id for s in entry.runner.ws.list_sessions()
    ):
        raise HTTPException(status_code=404, detail="session not found")
    decisions = entry.runner.ws.decisions
    records = (
        decisions.list(session_id)
        if include_settled
        else decisions.pending(session_id)
    )
    return [_to_response(r) for r in records]


@router.post("/{ask_id}", response_model=AskResponse)
async def answer_ask(
    workspace_id: str, ask_id: str, req: AnswerAskRequest, request: Request
) -> AskResponse:
    """Answer one waiting ask, allow or deny, and return the settled
    record. A known id with nothing waiting is 409 rather than 404, so
    an operator retrying a click reads "already answered", not "not
    found"."""
    entry = _require_entry(request, workspace_id)
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    if req.answer == "deny" and req.scope == "session":
        # covers() never lets a session-scoped deny answer anything: a
        # deny refuses the retry once, and asking again raises a new
        # record. Recording one would be a rule that can never speak.
        raise HTTPException(
            status_code=422,
            detail="a deny answers once; asking again raises a new record",
        )
    decisions = entry.runner.ws.decisions
    held = decisions.list()
    waiting = next(
        (r for r in held if r.id == ask_id and r.outcome is None), None
    )
    if waiting is None:
        if any(r.id == ask_id for r in held):
            raise HTTPException(
                status_code=409, detail=f"ask already answered: {ask_id}"
            )
        raise HTTPException(status_code=404, detail="ask not found")
    outcome = Outcome.ALLOW if req.answer == "allow" else Outcome.DENY
    scope = Scope(req.scope)
    try:
        await entry.runner.call(
            decisions.answer(ask_id, outcome, scope, req.note)
        )
    except KeyError as exc:
        # Answered between our read and the write: the id exists but
        # nothing is waiting under it any more.
        raise HTTPException(
            status_code=409, detail=f"ask already answered: {ask_id}"
        ) from exc
    return _to_response(
        dataclasses.replace(
            waiting, outcome=outcome, scope=scope, note=req.note
        )
    )
