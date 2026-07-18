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

from fastapi import APIRouter, HTTPException, Query, Request

from mirage import Workspace
from mirage.resource.registry import build_resource
from mirage.server.clone import clone_workspace_with_override
from mirage.server.paths import PathOutsideRootError, resolve_within_root
from mirage.server.summary import make_brief, make_detail
from mirage.utils.ids import new_workspace_id
from mirage.workspace.snapshot.utils import norm_mount_prefix
from mirage.workspace.store import DiskWorkspaceStateStore

from mirage.server.schemas import (  # isort: skip
    CloneWorkspaceRequest, CreateWorkspaceRequest, DeleteWorkspaceResponse,
    LoadWorkspaceRequest, SnapshotWorkspaceRequest, SnapshotWorkspaceResponse,
    WorkspaceBrief, WorkspaceDetail)

router = APIRouter(prefix="/v1/workspaces")


@router.post("", response_model=WorkspaceDetail, status_code=201)
async def create_workspace(req: CreateWorkspaceRequest,
                           request: Request) -> WorkspaceDetail:
    registry = request.app.state.registry
    if req.id is not None and req.id in registry:
        raise HTTPException(status_code=409,
                            detail=f"workspace id already exists: {req.id!r}")
    try:
        # Map runtime entries construct their instances here, so a bad
        # entry (a wasi build dir that does not exist, an unknown
        # option) fails the create like any other config mistake.
        kwargs = req.config.to_workspace_kwargs()
    except (FileNotFoundError, ImportError, ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    # The registry id and the state-store scope must be the same identity,
    # so resolve it before construction: explicit REST id, then the
    # config's workspace_id, then a fresh mint.
    wid = req.id or kwargs.get("workspace_id") or new_workspace_id()
    kwargs["workspace_id"] = wid
    # Daemon default is disk (a created workspace survives restart with
    # zero infrastructure, like git init); the library default stays ram.
    # A config with an explicit store: block always wins.
    if "store" not in kwargs:
        kwargs["store"] = DiskWorkspaceStateStore(
            str(request.app.state.state_root))
        kwargs["owns_store"] = True
    try:
        ws = Workspace(**kwargs)
    except (FileNotFoundError, ImportError, ValueError) as e:
        # Construction failures (a wasi build dir that does not exist, a
        # missing runtime extra) are the caller's to fix, not a 500.
        raise HTTPException(status_code=400, detail=str(e))
    try:
        for prefix, target in req.config.fuse_mounts().items():
            mountpoint = target if isinstance(target, str) else None
            ws.add_fuse_mount(prefix, mountpoint)
        entry = registry.add(ws, workspace_id=wid)
    except ValueError as e:
        await ws.close()
        raise HTTPException(status_code=409, detail=str(e))
    except Exception:
        await ws.close()
        raise
    return await make_detail(entry)


@router.get("", response_model=list[WorkspaceBrief])
async def list_workspaces(request: Request) -> list[WorkspaceBrief]:
    return [make_brief(e) for e in request.app.state.registry.list()]


@router.get("/{workspace_id}", response_model=WorkspaceDetail)
async def get_workspace(
    workspace_id: str, request: Request, verbose: bool = Query(False)
) -> WorkspaceDetail:  # noqa: E125
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    return await make_detail(registry.get(workspace_id), verbose=verbose)


@router.delete("/{workspace_id}", response_model=DeleteWorkspaceResponse)
async def delete_workspace(workspace_id: str,
                           request: Request) -> DeleteWorkspaceResponse:
    import time
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    await registry.remove(workspace_id)
    return DeleteWorkspaceResponse(id=workspace_id, closed_at=time.time())


@router.post("/{workspace_id}/clone",
             response_model=WorkspaceDetail,
             status_code=201)
async def clone_workspace(workspace_id: str, req: CloneWorkspaceRequest,
                          request: Request) -> WorkspaceDetail:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    if req.id is not None and req.id in registry:
        raise HTTPException(status_code=409,
                            detail=f"workspace id already exists: {req.id!r}")
    src_entry = registry.get(workspace_id)
    new_ws = await src_entry.runner.call(
        clone_workspace_with_override(src_entry.runner.ws, req.override))
    try:
        entry = registry.add(new_ws, workspace_id=req.id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return await make_detail(entry)


@router.post("/{workspace_id}/snapshot",
             response_model=SnapshotWorkspaceResponse)
async def snapshot_workspace(workspace_id: str, req: SnapshotWorkspaceRequest,
                             request: Request) -> SnapshotWorkspaceResponse:
    registry = request.app.state.registry
    if workspace_id not in registry:
        raise HTTPException(status_code=404, detail="workspace not found")
    entry = registry.get(workspace_id)
    try:
        target = resolve_within_root(request.app.state.snapshot_root, req.path)
    except PathOutsideRootError as e:
        raise HTTPException(status_code=400, detail=str(e))
    target.parent.mkdir(parents=True, exist_ok=True)
    await entry.runner.call(_run_snapshot(entry.runner.ws, str(target)))
    return SnapshotWorkspaceResponse(id=workspace_id,
                                     path=str(target),
                                     size=target.stat().st_size)


async def _run_snapshot(ws: Workspace, target: str) -> None:
    await ws.snapshot(target)


@router.post("/load", response_model=WorkspaceDetail, status_code=201)
async def load_workspace(req: LoadWorkspaceRequest,
                         request: Request) -> WorkspaceDetail:
    registry = request.app.state.registry
    try:
        safe_path = resolve_within_root(request.app.state.snapshot_root,
                                        req.path)
    except PathOutsideRootError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if req.id is not None and req.id in registry:
        raise HTTPException(status_code=409,
                            detail=f"workspace id already exists: {req.id!r}")
    resources = _build_load_resources(req.override)
    try:
        ws = await Workspace.load(str(safe_path), resources=resources)
    except FileNotFoundError:
        raise HTTPException(status_code=400,
                            detail=f"snapshot not found: {req.path}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        entry = registry.add(ws, workspace_id=req.id)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return await make_detail(entry)


def _build_load_resources(
        override: dict[str, Any] | None) -> dict[str, Any] | None:
    if not override or "mounts" not in override:
        return None
    out: dict[str, Any] = {}
    for prefix, block in override["mounts"].items():
        if not isinstance(block, dict):
            continue
        resource_name = block.get("resource")
        config = block.get("config") or {}
        if resource_name is None:
            continue
        out[norm_mount_prefix(prefix)] = build_resource(resource_name, config)
    return out or None
