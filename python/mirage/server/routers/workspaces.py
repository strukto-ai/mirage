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

import errno
import hashlib
import io
import json
import tarfile
import time
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any, TypeVar
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, Request, Response

from mirage import Workspace
from mirage.concurrency.limiter import run_blocking
from mirage.config import WorkspaceConfig, resolve_secrets
from mirage.secrets.errors import SecretsError
from mirage.server.clone import (
    build_override_mounts,
    clone_workspace_with_override,
)
from mirage.server.multipart import (
    MAX_REQUEST_PART,
    MAX_SNAPSHOT_PART,
    PartEvent,
    part_events,
)
from mirage.server.registry import Claim, WorkspaceEntry, WorkspaceRegistry
from mirage.server.schemas import (
    CancelLinesResponse,
    CloneWorkspaceRequest,
    CreateWorkspaceRequest,
    DeleteWorkspaceResponse,
    KillJobsResponse,
    LoadWorkspaceRequest,
    SnapshotWorkspaceRequest,
    SnapshotWorkspaceResponse,
    WorkspaceBrief,
    WorkspaceDetail,
)
from mirage.server.summary import make_brief, make_detail
from mirage.utils.ids import new_workspace_id
from mirage.vfs.s3.config import S3Config
from mirage.workspace.snapshot.utils import is_safe_blob_path
from mirage.workspace.store import DiskWorkspaceStateStore
from mirage.workspace.store.disk import DOT_IDS

router = APIRouter(prefix="/v1/workspaces")

# Under the snapshot store: one key prefix per account.
ACCOUNTS_DIR = "accounts"

T = TypeVar("T")


def _require_entry(request: Request, workspace_id: str) -> WorkspaceEntry:
    registry: WorkspaceRegistry = request.app.state.registry
    entry = registry.visible(workspace_id, request.state.account)
    if entry is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    return entry


async def _has_state(request: Request, workspace_id: str) -> bool:
    """Whether the server's state root holds state for ``workspace_id``.

    Args:
        request (Request): the request, for the app's state root.
        workspace_id (str): the id asked about.
    """
    store = DiskWorkspaceStateStore(str(request.app.state.state_root))
    try:
        return await store.load_meta(workspace_id) is not None
    finally:
        await store.close()


@asynccontextmanager
async def _claimed(request: Request, workspace_id: str) -> AsyncIterator[None]:
    """Hold the caller's claim on ``workspace_id`` while it is built.

    A claim this create made is released when the build fails, so a
    failed create leaves the id free; one the account already held (its
    own closed or stored workspace) stays.

    Args:
        request (Request): the creating request.
        workspace_id (str): the id being created.
    """
    registry = request.app.state.registry
    account = request.state.account
    stored = account is not None and await _has_state(request, workspace_id)
    claim = await registry.claim(workspace_id, account, stored)
    if claim is Claim.TAKEN:
        raise HTTPException(
            status_code=409,
            detail=f"workspace id already exists: {workspace_id!r}",
        )
    try:
        yield
    except BaseException:
        if claim is Claim.NEW:
            await registry.release(workspace_id)
        raise


def store_key(request: Request, key: str) -> str:
    """The key the caller's snapshot ``key`` has in the store.

    An account's snapshots live under its own prefix, so no account can
    write or load another's by naming its key.

    Args:
        request (Request): the request naming a snapshot.
        key (str): the key the caller gave.
    """
    relative = key.lstrip("/")
    if not is_safe_blob_path(relative):
        raise HTTPException(
            status_code=400, detail=f"invalid snapshot key: {key!r}"
        )
    account = request.state.account
    if account is None:
        return relative
    return f"{ACCOUNTS_DIR}/{quote(account, safe='')}/{relative}"


async def run_capture(
    entry: WorkspaceEntry, capture: Coroutine[Any, Any, T]
) -> T:
    """Run a capture (snapshot, clone) on the workspace's loop.

    A workspace whose lines do not end in time answers 409: cancel them
    and retry.

    Args:
        entry (WorkspaceEntry): the workspace captured.
        capture (Coroutine): the capture to run.
    """
    try:
        return await entry.runner.call(capture)
    except OSError as exc:
        if exc.errno != errno.EBUSY:
            raise
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _refuse_dot_id(workspace_id: str | None) -> None:
    """Refuse an id that would name the state root, not a workspace.

    Args:
        workspace_id (str | None): the id the request names, if any.
    """
    if workspace_id is not None and workspace_id in DOT_IDS:
        raise HTTPException(
            status_code=400, detail=f"invalid workspace id: {workspace_id!r}"
        )


def config_digest(config: WorkspaceConfig) -> str:
    """A stable fingerprint of the config a workspace was created from.

    Args:
        config (WorkspaceConfig): the config, its secret pointers unresolved.

    Returns:
        str: the SHA-256 of its canonical JSON.
    """
    canonical = json.dumps(config.model_dump(mode="json"), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


@router.post("", response_model=WorkspaceDetail, status_code=201)
async def create_workspace(
    req: CreateWorkspaceRequest, request: Request, response: Response
) -> WorkspaceDetail:
    """Create a workspace, or answer the live one created from this config.

    Creating is idempotent for one config: an id already held by a
    workspace created from an identical config answers that workspace
    with 200, so a client that names its workspace can run again and
    reach it; an id held by anything else is refused with 409.

    Args:
        req (CreateWorkspaceRequest): the config and an optional id.
        request (Request): the HTTP request, for the app's registry.
        response (Response): the response, whose status a held id sets.

    Returns:
        WorkspaceDetail: the created or the matching live workspace.
    """
    registry = request.app.state.registry
    digest = config_digest(req.config)
    # The registry id and the state-store scope must be the same identity,
    # so resolve it before construction: explicit REST id, then the
    # config's workspace_id, then a fresh mint. A held id is answered or
    # refused here, before its secrets resolve or its mounts build, and
    # before a second Workspace opens the live one's state; one being
    # deleted is refused, since its state is about to go. Creates of one
    # id run one at a time, so a second of the same config answers what
    # the first built, and one of another config is refused at once.
    wid = (
        req.id
        if req.id is not None
        else req.config.workspace_id or new_workspace_id()
    )
    _refuse_dot_id(wid)
    async with registry.creating(wid, digest) as admitted:
        if not admitted:
            raise HTTPException(
                status_code=409,
                detail=f"workspace id already exists: {wid!r}",
            )
        if wid in registry or registry.removing(wid):
            held = registry.visible(wid, request.state.account)
            if (
                held is None
                or registry.removing(wid)
                or held.config_digest != digest
            ):
                raise HTTPException(
                    status_code=409,
                    detail=f"workspace id already exists: {wid!r}",
                )
            response.status_code = 200
            return await make_detail(held)
        async with _claimed(request, wid):
            try:
                # Map runtime entries construct their instances here, so a bad
                # entry (a wasi build dir that does not exist, an unknown
                # option) fails the create like any other config mistake.
                kwargs = (
                    await resolve_secrets(req.config)
                ).to_workspace_kwargs()
            except (
                FileNotFoundError,
                ImportError,
                SecretsError,
                ValueError,
                TypeError,
            ) as e:
                raise HTTPException(status_code=400, detail=str(e))
            kwargs["workspace_id"] = wid
            # Daemon default is disk (a created workspace survives restart with
            # zero infrastructure, like git init); the library default stays ram.
            # A config with an explicit store: block always wins.
            if "store" not in kwargs:
                kwargs["store"] = DiskWorkspaceStateStore(
                    str(request.app.state.state_root)
                )
                kwargs["owns_store"] = True
            try:
                ws = Workspace(**kwargs)
            except (
                FileNotFoundError,
                ImportError,
                SecretsError,
                ValueError,
            ) as e:
                # Construction failures (a wasi build dir that does not exist, a
                # missing runtime extra, a `secrets:` block naming a source the
                # host cannot resolve) are the caller's to fix, not a 500.
                raise HTTPException(status_code=400, detail=str(e))
            try:
                for prefix, (
                    backend,
                    mountpoint,
                ) in req.config.kernel_mounts().items():
                    await run_blocking(
                        ws.add_fuse_mount, prefix, mountpoint, backend=backend
                    )
                entry = registry.add(
                    ws, workspace_id=wid, owner=request.state.account
                )
                entry.config_digest = digest
            except ValueError as e:
                await ws.close()
                raise HTTPException(status_code=409, detail=str(e))
            except Exception:
                await ws.close()
                raise
        return await make_detail(entry)


@router.get("", response_model=list[WorkspaceBrief])
async def list_workspaces(request: Request) -> list[WorkspaceBrief]:
    registry = request.app.state.registry
    account = request.state.account
    return [
        make_brief(e)
        for e in registry.list()
        if registry.visible(e.id, account) is not None
    ]


@router.get("/{workspace_id}", response_model=WorkspaceDetail)
async def get_workspace(
    workspace_id: str, request: Request, verbose: bool = Query(False)
) -> WorkspaceDetail:
    return await make_detail(
        _require_entry(request, workspace_id), verbose=verbose
    )


@router.delete("/{workspace_id}", response_model=DeleteWorkspaceResponse)
async def delete_workspace(
    workspace_id: str, request: Request
) -> DeleteWorkspaceResponse:
    registry = request.app.state.registry
    _require_entry(request, workspace_id)
    try:
        await registry.remove(workspace_id)
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"workspace delete failed: {exc}"
        ) from exc
    return DeleteWorkspaceResponse(id=workspace_id, closed_at=time.time())


@router.post("/{workspace_id}/close", response_model=DeleteWorkspaceResponse)
async def close_workspace(
    workspace_id: str, request: Request
) -> DeleteWorkspaceResponse:
    """Close the workspace and keep its state for the owner to reopen."""
    _require_entry(request, workspace_id)
    try:
        await request.app.state.registry.close(workspace_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="workspace not found")
    return DeleteWorkspaceResponse(id=workspace_id, closed_at=time.time())


@router.post("/{workspace_id}/cancel", response_model=CancelLinesResponse)
async def cancel_workspace_lines(
    workspace_id: str, request: Request
) -> CancelLinesResponse:
    """Cancel every session's running and queued lines; all stay open."""
    entry = _require_entry(request, workspace_id)
    canceled = await entry.runner.call(entry.runner.ws.cancel())
    return CancelLinesResponse(canceled=canceled)


@router.post("/{workspace_id}/kill", response_model=KillJobsResponse)
async def kill_workspace_jobs(
    workspace_id: str, request: Request
) -> KillJobsResponse:
    """Kill every session's background jobs and runners."""
    entry = _require_entry(request, workspace_id)
    killed = await entry.runner.call(entry.runner.ws.kill())
    return KillJobsResponse(killed=killed)


@router.post(
    "/{workspace_id}/clone", response_model=WorkspaceDetail, status_code=201
)
async def clone_workspace(
    workspace_id: str, req: CloneWorkspaceRequest, request: Request
) -> WorkspaceDetail:
    registry = request.app.state.registry
    src_entry = _require_entry(request, workspace_id)
    _refuse_dot_id(req.id)
    if req.id is not None and req.id in registry:
        raise HTTPException(
            status_code=409, detail=f"workspace id already exists: {req.id!r}"
        )
    wid = req.id or new_workspace_id()
    async with _claimed(request, wid):
        try:
            new_ws = await run_capture(
                src_entry,
                clone_workspace_with_override(
                    src_entry.runner.ws, req.override
                ),
            )
        except (SecretsError, ValueError) as e:
            # An override naming a source the host cannot resolve, or a
            # block the schema refuses, is the caller's mistake -- the
            # answer create, load and the historical clone already give.
            raise HTTPException(status_code=400, detail=str(e))
        try:
            entry = registry.add(
                new_ws, workspace_id=wid, owner=request.state.account
            )
        except ValueError as e:
            await new_ws.close()
            raise HTTPException(status_code=409, detail=str(e))
    return await make_detail(entry)


@router.get("/{workspace_id}/snapshot")
async def download_snapshot(workspace_id: str, request: Request) -> Response:
    entry = _require_entry(request, workspace_id)
    buffer = io.BytesIO()
    await run_capture(entry, entry.runner.ws.snapshot(buffer))
    return Response(content=buffer.getbuffer(), media_type="application/x-tar")


@router.post(
    "/{workspace_id}/snapshot", response_model=SnapshotWorkspaceResponse
)
async def snapshot_workspace(
    workspace_id: str, req: SnapshotWorkspaceRequest, request: Request
) -> SnapshotWorkspaceResponse:
    entry = _require_entry(request, workspace_id)
    store = _snapshot_store(request)
    size = await run_capture(
        entry, entry.runner.ws.snapshot(store_key(request, req.key), s3=store)
    )
    return SnapshotWorkspaceResponse(id=workspace_id, key=req.key, size=size)


@router.post("/load", response_model=WorkspaceDetail, status_code=201)
async def load_workspace(request: Request) -> WorkspaceDetail:
    registry = request.app.state.registry
    content_type = request.headers.get("content-type", "")
    tar: io.BytesIO | None = None
    if content_type.startswith("multipart/"):
        req, tar = await _read_load_body(request, content_type)
    else:
        req = _parse_load_request(await request.body())
        if req.key is None:
            raise HTTPException(
                status_code=400,
                detail="load needs a 'key' or an uploaded 'snapshot' part",
            )
    _refuse_dot_id(req.id)
    if req.id is not None and req.id in registry:
        raise HTTPException(
            status_code=409, detail=f"workspace id already exists: {req.id!r}"
        )
    store: S3Config | None = None
    source: Any = tar
    if tar is None and req.key is not None:
        store = _snapshot_store(request)
        source = store_key(request, req.key)
    wid = req.id or new_workspace_id()
    async with _claimed(request, wid):
        secrets = _build_load_secrets(req.override)
        try:
            # An override mount's credential may be a pointer at one of
            # these declarations; a container the constructor will reject
            # is left for it to reject.
            mounts = await build_override_mounts(req.override, secrets)
        except (KeyError, TypeError, ValueError, SecretsError) as e:
            # An override naming a VFS the daemon cannot build (an
            # unknown name, an unloadable ref, a ref that is not a VFS,
            # a secrets source it cannot resolve) is the caller's mistake,
            # the answer the TypeScript daemon gives too; it used to escape
            # as a 500.
            raise HTTPException(
                status_code=400, detail=f"override build failed: {e}"
            )
        try:
            ws = await Workspace.load(
                source, mounts=mounts, secrets=secrets, s3=store
            )
        except FileNotFoundError:
            raise HTTPException(
                status_code=400, detail=f"snapshot not found: {req.key}"
            )
        except (SecretsError, ValueError, tarfile.TarError, KeyError) as e:
            # A secrets override naming an unknown source, or one whose
            # optional dependency is absent, is a bad request like any
            # other override the deployment got wrong; so is an upload
            # that is not a snapshot.
            raise HTTPException(status_code=400, detail=f"load failed: {e}")
        try:
            entry = registry.add(
                ws, workspace_id=wid, owner=request.state.account
            )
        except ValueError as e:
            await ws.close()
            raise HTTPException(status_code=409, detail=str(e))
    return await make_detail(entry)


def _snapshot_store(request: Request) -> S3Config:
    """The S3-like store the server was given for snapshots.

    Args:
        request (Request): the request, for the app's store.

    Returns:
        S3Config: the store.

    Raises:
        HTTPException: 400 when the server has none.
    """
    store: S3Config | None = request.app.state.snapshot_store
    if store is None:
        raise HTTPException(
            status_code=400, detail="this server has no snapshot store"
        )
    return store


def _parse_load_request(body: bytes) -> LoadWorkspaceRequest:
    try:
        return LoadWorkspaceRequest.model_validate(json.loads(body or b"{}"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"bad load request: {e}")


async def _read_load_body(
    request: Request, content_type: str
) -> tuple[LoadWorkspaceRequest, io.BytesIO]:
    """Read an uploaded snapshot: a ``request`` part, then the tar.

    The tar is held in memory, never spooled to the server's disk, up to
    ``MAX_SNAPSHOT_PART`` bytes.

    Args:
        request (Request): the load request.
        content_type (str): its ``Content-Type`` header.

    Returns:
        tuple[LoadWorkspaceRequest, io.BytesIO]: the request and the tar.

    Raises:
        HTTPException: 400 for a body without both parts, or with a
            ``key``; 413 for an oversized part.
    """
    name = b""
    body = bytearray()
    tar = io.BytesIO()
    seen: set[bytes] = set()
    async for event, data in part_events(request.stream(), content_type):
        if event is PartEvent.BEGIN:
            name = data
            seen.add(name)
        elif event is PartEvent.DATA and name == b"request":
            body += data
            if len(body) > MAX_REQUEST_PART:
                raise HTTPException(
                    status_code=413, detail="request part too large"
                )
        elif event is PartEvent.DATA and name == b"snapshot":
            tar.write(data)
            if tar.tell() > MAX_SNAPSHOT_PART:
                raise HTTPException(
                    status_code=413, detail="snapshot part too large"
                )
    if b"snapshot" not in seen:
        raise HTTPException(
            status_code=400, detail="multipart body missing 'snapshot' part"
        )
    req = _parse_load_request(bytes(body))
    if req.key is not None:
        raise HTTPException(
            status_code=400,
            detail="load takes a 'key' or an uploaded 'snapshot', not both",
        )
    tar.seek(0)
    return req, tar


def _build_load_secrets(
    override: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """The `secrets:` declarations a load override supplies.

    A snapshot never carries the block, because it is the deployment's
    credentials, so a restored pointer at a declared instance needs it
    named here -- the same reason a redacted mount needs `mounts`.
    """
    if not override:
        return None
    # Passed through as it arrived, even when it is not a mapping: the
    # constructor is the one place that judges the container, and
    # filtering here turned a bad override into a successful load whose
    # every restored pointer was unresolvable.
    return override.get("secrets")
