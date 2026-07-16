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

from mirage import Workspace
from mirage.server.clone import clone_workspace_with_override
from mirage.server.summary import make_detail
from mirage.server.version.api import (branch, checkout, commit_state,
                                       diff_live_vs_ref, read_version,
                                       resolve_ref, status_state, version_diff,
                                       version_log)
from mirage.server.version.errors import HeadMovedError, NoSuchBranchError
from mirage.server.version.state_tree import to_state
from mirage.server.version.store import VersionStore
from mirage.workspace.snapshot import to_state_dict

from mirage.server.schemas import (  # isort: skip
    BranchRequest, BranchResponse, CheckoutRequest, CloneRequest,
    CommitRequest, CommitResponse, DiffResponse, VersionLogItem,
    WorkspaceDetail)

router = APIRouter(prefix="/v1")


async def _state_of(ws: Workspace) -> dict:
    return await to_state_dict(ws)


@router.post("/workspaces/{workspace_id}/commit",
             response_model=CommitResponse)
async def commit_version(workspace_id: str, req: CommitRequest,
                         request: Request) -> CommitResponse:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    entry = registry.get(workspace_id)
    state = await entry.runner.call(_state_of(entry.runner.ws))
    store = await VersionStore.open(request.app.state.version_backend,
                                    workspace_id)
    try:
        version = await commit_state(store, state, req.branch, req.message)
    except HeadMovedError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except NoSuchBranchError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return CommitResponse(version=version.decode(), branch=req.branch)


@router.get("/workspaces/{workspace_id}/versions",
            response_model=list[VersionLogItem])
async def list_versions(
    workspace_id: str, request: Request, branch: str = Query("main")
) -> list[VersionLogItem]:  # noqa: E125
    store = await VersionStore.open(request.app.state.version_backend,
                                    workspace_id)
    if branch not in await store.branches():
        return []
    entries = await version_log(store, branch)
    return [VersionLogItem(id=e["id"], message=e["message"]) for e in entries]


@router.post("/workspaces/{workspace_id}/branch",
             response_model=BranchResponse,
             status_code=201)
async def create_branch(workspace_id: str, req: BranchRequest,
                        request: Request) -> BranchResponse:
    store = await VersionStore.open(request.app.state.version_backend,
                                    workspace_id)
    if req.name in await store.branches():
        raise HTTPException(status_code=409,
                            detail=f"branch already exists: {req.name!r}")
    try:
        await branch(store, req.name, req.from_branch)
    except KeyError:
        raise HTTPException(status_code=404,
                            detail=f"no such branch: {req.from_branch!r}")
    head = await store.head(req.name)
    return BranchResponse(branch=req.name, version=head.decode())


@router.get("/workspaces/{workspace_id}/diff", response_model=DiffResponse)
async def diff_versions(
        workspace_id: str,
        request: Request,
        a: str | None = Query(None),
        b: str | None = Query(None),
        branch: str = Query("main"),
) -> DiffResponse:  # noqa: E125
    store = await VersionStore.open(request.app.state.version_backend,
                                    workspace_id)
    state = None
    if a is None or b is None:
        registry = request.app.state.registry
        if workspace_id not in registry:
            raise HTTPException(status_code=404, detail="workspace not found")
        entry = registry.get(workspace_id)
        state = await entry.runner.call(_state_of(entry.runner.ws))
    try:
        if a is not None and b is not None:
            changes = await version_diff(store, await resolve_ref(store, a),
                                         await resolve_ref(store, b))
        elif a is not None:
            assert state is not None
            changes = await diff_live_vs_ref(store, state, a)
        else:
            assert state is not None
            changes = await status_state(store, state, branch)
    except KeyError:
        raise HTTPException(status_code=404, detail="version not found")
    return DiffResponse(**changes)


@router.post("/workspaces/{workspace_id}/checkout",
             response_model=WorkspaceDetail)
async def checkout_version(workspace_id: str, req: CheckoutRequest,
                           request: Request) -> WorkspaceDetail:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    entry = registry.get(workspace_id)
    store = await VersionStore.open(request.app.state.version_backend,
                                    workspace_id)
    try:
        await entry.runner.call(checkout(store, entry.runner.ws, req.ref))
    except KeyError:
        raise HTTPException(status_code=404,
                            detail=f"version not found: {req.ref}")
    return await make_detail(entry)


@router.post("/workspaces/clone",
             response_model=WorkspaceDetail,
             status_code=201)
async def clone_workspace_version(req: CloneRequest,
                                  request: Request) -> WorkspaceDetail:
    registry = request.app.state.registry
    if req.id is not None and req.id in registry:
        raise HTTPException(status_code=409,
                            detail=f"workspace id already exists: {req.id!r}")
    if req.at is not None:
        store = await VersionStore.open(request.app.state.version_backend,
                                        req.source_id)
        version = await resolve_ref(store, req.at)
        try:
            entries, meta = await read_version(store, version)
        except KeyError:
            raise HTTPException(status_code=404,
                                detail=f"version not found: {req.at}")
        ws = await Workspace.from_state(to_state(entries, meta))
    else:
        if req.source_id not in registry:
            raise HTTPException(status_code=404, detail="workspace not found")
        src = registry.get(req.source_id)
        ws = await src.runner.call(
            clone_workspace_with_override(src.runner.ws, None))
    try:
        entry = registry.add(ws, workspace_id=req.id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return await make_detail(entry)
