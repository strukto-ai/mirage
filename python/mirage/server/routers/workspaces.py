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
import logging
import time
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any, TypeVar
from urllib.parse import quote

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError

from mirage import Workspace, WorkspaceRunner
from mirage.concurrency.limiter import run_blocking
from mirage.config import (
    WorkspaceConfig,
    _load_profile_policy,
    build_mcp_clis,
    config_state_store,
    resolve_secrets,
)
from mirage.io.network import NetworkRule, run_with_network
from mirage.policy.base import Policy
from mirage.policy.errors import PolicyDenied, PolicyError
from mirage.policy.profile import SessionProfile
from mirage.resources.errors import ResourceError
from mirage.resources.refs import secret_refs
from mirage.secrets.errors import SecretsError
from mirage.server.clone import (
    build_override_mounts,
    clone_workspace_with_override,
)
from mirage.server.constants import MAX_SNAPSHOT_BYTES
from mirage.server.errors import (
    INTERNAL_MESSAGE,
    ErrorCode,
    HttpError,
    loader_error,
    validation_error,
)
from mirage.server.io_serde import explanation_to_dict, refusal_to_dict
from mirage.server.logs import (
    LogPage,
    completed_logs,
    log_attachment,
    log_lines,
    log_page,
    session_filter,
)
from mirage.server.metrics import refused
from mirage.server.multipart import (
    MAX_REQUEST_PART,
    MAX_SNAPSHOT_PART,
    PartEvent,
    part_events,
)
from mirage.server.paths import load_daemon_id
from mirage.server.registry import Claim, Forget, WorkspaceEntry
from mirage.server.resources.policies import with_policies
from mirage.server.resources.strukto import with_entries
from mirage.server.routers.templates import (
    NO_WORKSPACE_ID,
    require_one_account,
    store_refusal,
)
from mirage.server.routers.vfs import require_entry
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
    check_config,
)
from mirage.server.summary import (
    make_brief,
    make_detail,
    make_stopped_brief,
    make_stopped_detail,
)
from mirage.types import Ceilings, JsonValue
from mirage.utils.ids import check_name, new_workspace_id
from mirage.vfs.s3.config import S3Config
from mirage.workspace.snapshot.utils import is_safe_blob_path
from mirage.workspace.store import DiskWorkspaceStateStore
from mirage.workspace.store.base import WorkspaceStateStore
from mirage.workspace.store.disk import DOT_IDS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/workspaces")

# Under the snapshot store: one key prefix per account.
ACCOUNTS_DIR = "accounts"

T = TypeVar("T")


def refused_build(exc: Exception, fixed: str) -> HttpError:
    """A build the caller's config or snapshot made fail, as a 400: the
    project's own loaders word theirs for the caller; an OS or
    interpreter error, which names the server's own paths and modules,
    answers ``fixed`` and goes to the log.

    Args:
        exc (Exception): what the build raised.
        fixed (str): the message for an error the caller may not read.
    """
    if isinstance(exc, (ValueError, TypeError, SecretsError)):
        return loader_error(exc)
    logger.info("mirage: %s: %s", fixed, exc)
    return HttpError(ErrorCode.INVALID_REQUEST, fixed)


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


def _store_of(
    request: Request, config: dict[str, JsonValue] | None
) -> WorkspaceStateStore:
    """The store a workspace built from ``config`` keeps its state in:
    the one its ``store:`` block names, else the server's. A config that
    no longer checks names none the server can open, so the server's is
    read.

    Args:
        request (Request): the request, for the app's state root.
        config (dict[str, JsonValue] | None): the saved config.
    """
    if config is not None and config.get("store") is not None:
        try:
            named = config_state_store(check_config(config))
        except ValueError as exc:
            logger.debug(
                "mirage: a saved config's store did not open: %s", exc
            )
        else:
            if named is not None:
                return named
    return DiskWorkspaceStateStore(str(request.app.state.state_root))


async def _kept(
    request: Request, workspace_id: str
) -> tuple[dict[str, JsonValue], float] | None:
    """What the caller's stopped ``workspace_id`` keeps: the config it
    starts from and when it was first created, or None when no config is
    saved. State alone, as a rejected create leaves, is not a workspace
    to list or start. A store that cannot be read, such as a Redis that
    is down, leaves the config with no creation time.

    Args:
        request (Request): the request, for the registry and its account.
        workspace_id (str): the id asked about.
    """
    registry = request.app.state.registry
    account = request.state.account
    if not await registry.allows(workspace_id, account, 0.0):
        return None
    config = await registry.saved_config(workspace_id, account)
    if config is None:
        return None
    store = _store_of(request, config)
    try:
        meta = await store.load_meta(workspace_id)
    except Exception as exc:
        logger.warning(
            "mirage: workspace %s's store could not be read: %s",
            workspace_id,
            exc,
        )
        meta = None
    finally:
        await store.close()
    created_at = (meta or {}).get("created_at")
    return config, (
        float(created_at) if isinstance(created_at, (int, float)) else 0.0
    )


async def is_stopped(request: Request, workspace_id: str) -> bool:
    """Whether the caller's ``workspace_id``, not live, is stopped: its
    state or its config is kept.

    Args:
        request (Request): the request, for the registry and its account.
        workspace_id (str): the id asked about.
    """
    if workspace_id in DOT_IDS:
        return False
    registry = request.app.state.registry
    account = request.state.account
    if not await registry.allows(workspace_id, account, 0.0):
        return False
    if await _has_state(request, workspace_id):
        return True
    return await registry.saved_config(workspace_id, account) is not None


@asynccontextmanager
async def _claimed(request: Request, workspace_id: str) -> AsyncIterator[None]:
    """Hold the caller's claim on ``workspace_id`` while it is built.

    A server at its ``max_workspaces`` answers 503 before anything is
    built. A claim this create made is released when the build fails
    before saving any state, so a failed create leaves the id free. Once
    state is saved the claim stays with it, as for the account's own
    closed workspace: the account can create the id again, and no state
    is deleted that another server sharing the state root may be using.
    One the account already held stays.

    Args:
        request (Request): the creating request.
        workspace_id (str): the id being created.
    """
    registry = request.app.state.registry
    if registry.draining:
        refused("shutting_down")
        raise HttpError(ErrorCode.SHUTTING_DOWN, "server is shutting down")
    if not registry.has_room():
        refused("max_workspaces")
        raise HttpError(
            ErrorCode.SERVER_FULL,
            f"server is at max_workspaces ({registry.max_workspaces})",
        )
    account = request.state.account
    stored = account is not None and await _has_state(request, workspace_id)
    claim = await registry.claim(workspace_id, account, stored)
    if claim is Claim.TAKEN:
        raise HttpError(
            ErrorCode.ALREADY_EXISTS, "workspace id already exists"
        )
    try:
        yield
    except BaseException:
        if claim is Claim.NEW and not await _has_state(request, workspace_id):
            await registry.release(workspace_id)
        raise


@asynccontextmanager
async def _building(
    request: Request, workspace_id: str
) -> AsyncIterator[None]:
    """Hold ``workspace_id`` for a clone or load while it is built.

    No create of the id runs alongside, so none can take over a claim
    this build made and then lose it when the build fails and releases
    it; the caller's claim covers the build.

    Args:
        request (Request): the cloning or loading request.
        workspace_id (str): the id being built.
    """
    registry = request.app.state.registry
    build = f"build:{new_workspace_id()}"
    async with registry.creating(workspace_id, build) as admitted:
        if not admitted:
            raise HttpError(
                ErrorCode.ALREADY_EXISTS, "workspace id already exists"
            )
        async with _claimed(request, workspace_id):
            yield


async def _construct(
    config: WorkspaceConfig,
    rule: NetworkRule | None,
    workspace_id: str,
    state_root: str,
    daemon_id: str,
    max_sessions: int | None,
    ceilings: Ceilings,
) -> Workspace:
    """Build a workspace from its config, on the loop that awaits this:
    its secrets are read, its mounts and runtimes constructed and their
    backends imported there, not on the server's loop.

    Map runtime entries construct their instances here, so a bad entry
    fails the create like any other config mistake. A secret the config
    names is read under the network the workspace will be held to. The
    server's default store is disk, so a created workspace survives a
    restart with no infrastructure; a config's own ``store:`` block wins.
    Under ``max_sessions`` the sessions its store saved are loaded, and
    more than the cap refuse the create.

    Args:
        config (WorkspaceConfig): the posted config.
        rule (NetworkRule | None): the network the workspace is held to.
        workspace_id (str): the id it is created under.
        state_root (str): where the default disk store keeps its state.
        daemon_id (str): the server's id, which the workspace's lease
            names while the server runs its lines.
        max_sessions (int | None): the server's session cap.
        ceilings (Ceilings): the server's ceilings, which hold the
            config's limits.

    Raises:
        ValueError: the saved sessions are past the cap.
    """
    resolved = await run_with_network(rule, resolve_secrets(config))
    kwargs = resolved.to_workspace_kwargs(
        mcp_clis=await run_with_network(rule, build_mcp_clis(resolved))
    )
    kwargs["workspace_id"] = workspace_id
    kwargs["daemon_id"] = daemon_id
    kwargs["ceilings"] = ceilings
    if "store" not in kwargs:
        kwargs["store"] = DiskWorkspaceStateStore(state_root)
        kwargs["owns_store"] = True
    ws = Workspace(**kwargs)
    if max_sessions is None:
        return ws
    try:
        await ws.ensure_sessions_loaded()
        past = _past_session_cap(ws, max_sessions, "the saved workspace")
        if past is not None:
            raise ValueError(past)
    except BaseException:
        await ws.close()
        raise
    return ws


def _past_session_cap(
    ws: Workspace, cap: int | None, holder: str
) -> str | None:
    """Why ``ws`` holds too many sessions for the server, None when it
    does not; a refusal is counted.

    Args:
        ws (Workspace): the workspace built.
        cap (int | None): the server's ``max_sessions``.
        holder (str): what the sessions came from, for the refusal.
    """
    held = len(ws.list_sessions())
    if cap is None or held <= cap:
        return None
    refused("max_sessions")
    return f"{holder} holds {held} sessions, past max_sessions ({cap})"


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
        raise HttpError(
            ErrorCode.INVALID_VALUE,
            "key must be a relative path inside the snapshot store",
            param="key",
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
        raise HttpError(ErrorCode.CONFLICT, str(exc)) from exc


def _refuse_id(workspace_id: str | None) -> None:
    """Refuse an id that would name the state root, not a workspace, or
    that breaks the rule every name a caller gives keeps.

    Args:
        workspace_id (str | None): the id the request names, if any.
    """
    if workspace_id is None:
        return
    try:
        check_name("workspace id", workspace_id)
    except ValueError as exc:
        raise loader_error(exc) from exc
    if workspace_id in DOT_IDS:
        raise HttpError(
            ErrorCode.INVALID_VALUE,
            "id must not be . or ..",
            param="id",
        )


async def _admit(request: Request, config: dict[str, Any]) -> None:
    """Refuse a workspace the server's policies refuse, before any of it
    is built or any secret it names is read.

    Args:
        request (Request): the request, for the registry and its account.
        config (dict[str, Any]): the config as the caller wrote it.

    Raises:
        HttpError: 403 with the refusal's reason.
    """
    refused = await request.app.state.registry.refusal(
        config, request.state.account
    )
    if refused is not None:
        raise HttpError(ErrorCode.POLICY_REFUSED, refused.reason)


def config_digest(config: WorkspaceConfig) -> str:
    """A stable fingerprint of the config a workspace was created from.

    Args:
        config (WorkspaceConfig): the config, its secret pointers unresolved.

    Returns:
        str: the SHA-256 of its canonical JSON.
    """
    canonical = json.dumps(config.model_dump(mode="json"), sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


async def _config_of(
    req: CreateWorkspaceRequest, request: Request
) -> tuple[WorkspaceConfig, dict[str, Any]]:
    """The config a create builds, checked and as written: the body's own,
    or a copy of the named template's, so a later edit of the template
    leaves the workspace as it is.

    Args:
        req (CreateWorkspaceRequest): the create's body.
        request (Request): the HTTP request, for its JSON and the store.

    Raises:
        HttpError: 400 for both or neither, 404 for an unknown
            template, 501 for a template on a server of many accounts.
    """
    if req.template is None:
        if req.config is None:
            raise HttpError(
                ErrorCode.INVALID_REQUEST, "give a template or a config"
            )
        return req.config, (await request.json())["config"]
    if req.config is not None:
        raise HttpError(
            ErrorCode.INVALID_REQUEST, "give a template or a config, not both"
        )
    require_one_account(request)
    try:
        template = await request.app.state.resources.get_template(req.template)
    except ResourceError as e:
        raise store_refusal(e) from e
    try:
        config = check_config(template.config)
    except ValueError as e:
        raise loader_error(e, ("config",)) from e
    if config.workspace_id is not None:
        raise HttpError(ErrorCode.INVALID_REQUEST, NO_WORKSPACE_ID)
    return config, template.config


async def _with_saved(
    request: Request, config: WorkspaceConfig, written: dict[str, Any]
) -> WorkspaceConfig:
    """The config a create builds, with the saved entries its pointers
    name filled in and each policy script that names a saved policy given
    its source; after the digest and the policies, which judge the config
    as written and never see a sealed value.

    Args:
        request (Request): the HTTP request, for the app's store.
        config (WorkspaceConfig): the checked config.
        written (dict[str, Any]): the config as written.

    Raises:
        HttpError: 501 for pointers on a server of many accounts, 400
            for a name that is not saved or a saved value its field cannot
            take.
    """
    refs = secret_refs(written)
    store = request.app.state.resources
    try:
        named = (
            written
            if request.app.state.registry.accounts_required
            else await with_policies(store, written)
        )
        if not refs:
            return config if named is written else check_config(named)
        require_one_account(request)
        return await with_entries(store, named, refs)
    except ResourceError as e:
        raise store_refusal(e) from e


async def _open_workspace(
    request: Request,
    response: Response,
    wid: str,
    config: WorkspaceConfig,
    written: dict[str, Any],
) -> WorkspaceDetail:
    """Build ``config`` as workspace ``wid``, or answer the live one built
    from it, and keep the config for ``start``.

    Builds of one id run one at a time, so a second of the same config
    answers what the first built, and one of another config is refused
    at once. A held id is answered or refused before its secrets resolve
    or its mounts build, and before a second Workspace opens the live
    one's state; one being deleted or stopped is refused, since its state
    is about to go or is still being written. The server's policies judge
    the config as written before any of it is built.

    Args:
        request (Request): the HTTP request, for the app's registry.
        response (Response): the response, whose status a held id sets.
        wid (str): the workspace id.
        config (WorkspaceConfig): the checked config.
        written (dict[str, Any]): the config as written.
    """
    registry = request.app.state.registry
    digest = config_digest(config)
    async with registry.creating(wid, digest) as admitted:
        if not admitted:
            raise HttpError(
                ErrorCode.ALREADY_EXISTS, "workspace id already exists"
            )
        if wid in registry or registry.removing(wid):
            held = registry.visible(wid, request.state.account)
            if (
                held is None
                or registry.removing(wid)
                or held.config_digest != digest
            ):
                raise HttpError(
                    ErrorCode.ALREADY_EXISTS, "workspace id already exists"
                )
            response.status_code = 200
            return await make_detail(held)
        await _admit(request, written)
        built = await _with_saved(request, config, written)
        async with _claimed(request, wid):
            try:
                runner = await WorkspaceRunner.build(
                    _construct(
                        built,
                        registry.rule_for(config.network),
                        wid,
                        str(request.app.state.state_root),
                        await run_blocking(
                            load_daemon_id, request.app.state.state_root
                        ),
                        registry.max_sessions,
                        registry.ceilings,
                    )
                )
            except (
                FileNotFoundError,
                ImportError,
                SecretsError,
                ValueError,
                TypeError,
            ) as e:
                # Config mistakes (a wasi build dir that does not exist, an
                # unknown runtime option, a missing runtime extra, a
                # `secrets:` block naming a source the host cannot resolve)
                # are the caller's to fix, not a 500.
                raise refused_build(e, "config could not be built")
            try:
                for prefix, (
                    backend,
                    mountpoint,
                ) in config.kernel_mounts().items():
                    await run_blocking(
                        runner.ws.add_fuse_mount,
                        prefix,
                        mountpoint,
                        backend=backend,
                    )
                await registry.save_config(wid, written)
                entry = registry.add(
                    runner, workspace_id=wid, owner=request.state.account
                )
                entry.config_digest = digest
            except ValueError as e:
                await runner.stop()
                raise HttpError(ErrorCode.CONFLICT, str(e))
            except BaseException:
                # A cancelled create stops the runner too: nothing else
                # holds it before it is registered.
                await runner.stop()
                raise
        return await make_detail(entry)


@router.post("", response_model=WorkspaceDetail, status_code=201)
async def create_workspace(
    req: CreateWorkspaceRequest,
    request: Request,
    response: Response,
    explain: bool = Query(False),
) -> WorkspaceDetail | Response:
    """Create a workspace, or answer the live one created from this config.

    Creating is idempotent for one config: an id already held by a
    workspace created from an identical config answers that workspace
    with 200, so a client that names its workspace can run again and
    reach it; an id held by anything else is refused with 409. The
    server's policies judge the config as written (``pre_workspace``)
    before any of it is built: a refusal is 403 with its reason, and
    ``explain`` answers what they say without creating anything.

    Args:
        req (CreateWorkspaceRequest): the config or a template's name,
            and an optional id.
        request (Request): the HTTP request, for the app's registry.
        response (Response): the response, whose status a held id sets.
        explain (bool): answer what the server's policies say instead.

    Returns:
        WorkspaceDetail | Response: the created or the matching live
            workspace, or the explanation.
    """
    registry = request.app.state.registry
    config, written = await _config_of(req, request)
    if explain:
        said = await registry.explanation(written, request.state.account)
        return JSONResponse(content=explanation_to_dict(said))
    # The registry id and the state-store scope must be the same identity,
    # so resolve it before construction: explicit REST id, then the
    # config's workspace_id, then a fresh mint.
    wid = (
        req.id
        if req.id is not None
        else config.workspace_id or new_workspace_id()
    )
    _refuse_id(wid)
    return await _open_workspace(request, response, wid, config, written)


@router.get("", response_model=list[WorkspaceBrief])
async def list_workspaces(request: Request) -> list[WorkspaceBrief]:
    """The running workspaces, then the stopped ones.

    Args:
        request (Request): the request, for the registry and its account.
    """
    registry = request.app.state.registry
    account = request.state.account
    briefs = [
        make_brief(e)
        for e in registry.list()
        if registry.visible(e.id, account) is not None
    ]
    # One that stops while this reads is listed once, as it was first read.
    listed = {brief.id for brief in briefs}
    for wid in await registry.stopped_ids(account):
        if wid in listed:
            continue
        kept = await _kept(request, wid)
        if kept is not None:
            briefs.append(make_stopped_brief(wid, kept[1]))
    return briefs


@router.get("/{workspace_id}", response_model=WorkspaceDetail)
async def get_workspace(
    workspace_id: str, request: Request, verbose: bool = Query(False)
) -> WorkspaceDetail:
    registry = request.app.state.registry
    entry = registry.visible(workspace_id, request.state.account)
    if entry is None:
        kept = await _kept(request, workspace_id)
        if kept is None:
            raise HttpError(ErrorCode.NOT_FOUND, "workspace not found")
        return make_stopped_detail(workspace_id, *kept)
    # A workspace being deleted keeps its id until the deletion is done,
    # but its runner has stopped answering: it is gone to a reader.
    if registry.removing(workspace_id):
        raise HttpError(ErrorCode.NOT_FOUND, "workspace not found")
    return await make_detail(entry, verbose=verbose)


@router.get(
    "/{workspace_id}/logs",
    response_model=LogPage,
    responses={
        200: {
            "content": {"application/x-ndjson": {"schema": {"type": "string"}}}
        }
    },
)
async def workspace_logs(
    workspace_id: str,
    request: Request,
    session: str | None = Query(None),
    limit: str = Query("50"),
    after: str | None = Query(None),
    format: str = Query("json"),
) -> LogPage | Response:
    """Read completed commands, newest first, or export their records.

    Args:
        workspace_id (str): workspace ID.
        request (Request): registry request.
        session (str | None): session filter.
        limit (str): page size, 1-200.
        after (str | None): opaque pagination cursor.
        format (str): jsonl requests an export; otherwise JSON.
    """
    entry = require_entry(request, workspace_id)
    if request.app.state.registry.removing(workspace_id):
        raise HttpError(ErrorCode.NOT_FOUND, "workspace not found")
    try:
        selected_session = session_filter(session)
        if format != "jsonl":
            log_page([], limit, after)
    except ValueError as exc:
        raise loader_error(exc) from exc
    records = await entry.runner.call(
        entry.runner.ws.observer.events(selected_session)
    )
    logs = await run_blocking(completed_logs, records)
    if format == "jsonl":
        return StreamingResponse(
            log_lines(logs),
            media_type="application/x-ndjson",
            headers={"Content-Disposition": log_attachment(workspace_id)},
        )
    return await run_blocking(log_page, logs, limit, after)


@router.delete("/{workspace_id}", response_model=DeleteWorkspaceResponse)
async def delete_workspace(
    workspace_id: str, request: Request
) -> DeleteWorkspaceResponse:
    """Delete the workspace, running or stopped: its state, config and
    owner go.

    Args:
        workspace_id (str): the workspace.
        request (Request): the request, for the registry and its account.
    """
    registry = request.app.state.registry
    if registry.visible(workspace_id, request.state.account) is None:
        kept = await _kept(request, workspace_id)
        if kept is None:
            raise HttpError(ErrorCode.NOT_FOUND, "workspace not found")
        store = _store_of(request, kept[0])
        try:
            forgot = await registry.forget(
                workspace_id, request.state.account, kept[0], store
            )
        finally:
            await store.close()
        if forgot is Forget.GONE:
            raise HttpError(ErrorCode.NOT_FOUND, "workspace not found")
        if forgot is Forget.HELD:
            raise HttpError(
                ErrorCode.WORKSPACE_BUSY,
                "workspace is running on another server",
            )
        if forgot is Forget.BUSY:
            raise HttpError(
                ErrorCode.WORKSPACE_BUSY,
                "workspace is starting or stopping; try again",
            )
        return DeleteWorkspaceResponse(id=workspace_id, closed_at=time.time())
    try:
        await registry.remove(workspace_id)
    except Exception as exc:
        logger.error("mirage: workspace delete failed", exc_info=exc)
        raise HttpError(ErrorCode.INTERNAL, INTERNAL_MESSAGE) from exc
    return DeleteWorkspaceResponse(id=workspace_id, closed_at=time.time())


@router.post("/{workspace_id}/stop", response_model=DeleteWorkspaceResponse)
async def stop_workspace(
    workspace_id: str, request: Request
) -> DeleteWorkspaceResponse:
    """Stop the workspace and keep its state and config for ``start``.

    A stopped workspace answers as it is, so a stop can be repeated.

    Args:
        workspace_id (str): the workspace.
        request (Request): the request, for the registry and its account.
    """
    registry = request.app.state.registry
    account = request.state.account
    live = registry.visible(workspace_id, account) is not None
    if not live and not await is_stopped(request, workspace_id):
        raise HttpError(ErrorCode.NOT_FOUND, "workspace not found")
    if live or registry.removing(workspace_id):
        await registry.stop(workspace_id)
    return DeleteWorkspaceResponse(id=workspace_id, closed_at=time.time())


@router.post("/{workspace_id}/start", response_model=WorkspaceDetail)
async def start_workspace(
    workspace_id: str, request: Request, response: Response
) -> WorkspaceDetail:
    """Start a stopped workspace from the config it was created with, over
    the state it kept; a running one answers as it is.

    The server's policies judge the config again, and the secrets and
    saved entries it names are read again, so a rotated secret is picked
    up.

    Args:
        workspace_id (str): the workspace.
        request (Request): the request, for the registry and its account.
        response (Response): the response, whose status a held id sets.
    """
    registry = request.app.state.registry
    account = request.state.account
    held = registry.visible(workspace_id, account)
    if held is not None and not registry.removing(workspace_id):
        return await make_detail(held)
    written = await registry.saved_config(workspace_id, account)
    if written is None:
        raise HttpError(ErrorCode.NOT_FOUND, "workspace not found")
    try:
        config = check_config(written)
    except ValueError as e:
        raise loader_error(e, ("config",)) from e
    return await _open_workspace(
        request, response, workspace_id, config, written
    )


@router.post("/{workspace_id}/cancel", response_model=CancelLinesResponse)
async def cancel_workspace_lines(
    workspace_id: str, request: Request
) -> CancelLinesResponse:
    """Cancel every session's running and queued lines; all stay open."""
    entry = require_entry(request, workspace_id)
    canceled = await entry.runner.call(entry.runner.ws.cancel())
    return CancelLinesResponse(canceled=canceled)


@router.post("/{workspace_id}/kill", response_model=KillJobsResponse)
async def kill_workspace_jobs(
    workspace_id: str, request: Request
) -> KillJobsResponse:
    """Kill every session's background jobs and runners."""
    entry = require_entry(request, workspace_id)
    killed = await entry.runner.call(entry.runner.ws.kill())
    return KillJobsResponse(killed=killed)


@router.put("/{workspace_id}/profiles/{name}")
async def set_profile(
    workspace_id: str, name: str, profile: SessionProfile, request: Request
) -> dict[str, str]:
    """Define a named profile on the live workspace, or replace it.

    Only the live table changes: a session moves when it is updated
    onto the name, and the workspace's config is never rewritten.

    Args:
        workspace_id (str): the workspace.
        name (str): the profile's name.
        profile (SessionProfile): the document, as a config's
            ``profiles`` entry states it.
        request (Request): the HTTP request, for the app's registry.
    """
    entry = require_entry(request, workspace_id)

    async def define() -> None:
        entry.runner.ws.set_profile(name, doc)

    try:
        doc = _load_profile_policy(profile)
        await entry.runner.call(define())
    except (OSError, ValueError, PolicyError, SecretsError) as exc:
        raise loader_error(exc) from exc
    return {"name": name}


@router.post(
    "/{workspace_id}/clone", response_model=WorkspaceDetail, status_code=201
)
async def clone_workspace(
    workspace_id: str, req: CloneWorkspaceRequest, request: Request
) -> WorkspaceDetail:
    registry = request.app.state.registry
    src_entry = require_entry(request, workspace_id)
    _refuse_id(req.id)
    if req.id is not None and req.id in registry:
        raise HttpError(
            ErrorCode.ALREADY_EXISTS, "workspace id already exists"
        )
    wid = req.id or new_workspace_id()
    await _admit(request, req.override or {})
    async with _building(request, wid):
        try:
            new_ws = await run_capture(
                src_entry,
                run_with_network(
                    registry.rule_for(src_entry.runner.ws.network),
                    clone_workspace_with_override(
                        src_entry.runner.ws, req.override
                    ),
                ),
            )
        except (SecretsError, ValueError) as e:
            # An override naming a source the host cannot resolve, or a
            # block the schema refuses, is the caller's mistake -- the
            # answer create, load and the historical clone already give.
            raise refused_build(e, "override could not be built")
        try:
            entry = registry.add(
                new_ws, workspace_id=wid, owner=request.state.account
            )
        except ValueError as e:
            await new_ws.close()
            raise HttpError(ErrorCode.CONFLICT, str(e))
        await registry.drop_config(wid)
    return await make_detail(entry)


@router.get("/{workspace_id}/snapshot")
async def download_snapshot(workspace_id: str, request: Request) -> Response:
    entry = require_entry(request, workspace_id)
    buffer = io.BytesIO()
    await run_capture(entry, entry.runner.ws.snapshot(buffer))
    return Response(content=buffer.getbuffer(), media_type="application/x-tar")


@router.post(
    "/{workspace_id}/snapshot", response_model=SnapshotWorkspaceResponse
)
async def snapshot_workspace(
    workspace_id: str, req: SnapshotWorkspaceRequest, request: Request
) -> SnapshotWorkspaceResponse:
    entry = require_entry(request, workspace_id)
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
            raise HttpError(
                ErrorCode.INVALID_REQUEST,
                "load needs a 'key' or an uploaded 'snapshot' part",
            )
    _refuse_id(req.id)
    if req.id is not None and req.id in registry:
        raise HttpError(
            ErrorCode.ALREADY_EXISTS, "workspace id already exists"
        )
    await _admit(request, req.override or {})
    store: S3Config | None = None
    source: Any = tar
    if tar is None and req.key is not None:
        store = _snapshot_store(request)
        source = store_key(request, req.key)
    wid = req.id or new_workspace_id()
    # What the snapshot holds is built under the server's network; its own
    # setting is not known until it is read.
    rule = registry.rule_for()
    async with _building(request, wid):
        secrets = _build_load_secrets(req.override)
        try:
            # An override mount's credential may be a pointer at one of
            # these declarations; a container the constructor will reject
            # is left for it to reject.
            mounts = await run_with_network(
                rule, build_override_mounts(req.override, secrets)
            )
        except (KeyError, TypeError, ValueError, SecretsError) as e:
            # An override naming a VFS the daemon cannot build (an
            # unknown name, an unloadable ref, a ref that is not a VFS,
            # a secrets source it cannot resolve) is the caller's mistake,
            # the answer the TypeScript daemon gives too; it used to escape
            # as a 500.
            raise refused_build(e, "override could not be built")
        restored: list[Policy] = []

        # The snapshot's saved values meet the server's policies as a live
        # write does, before any of them lands; the restore runs on the
        # loop the workspace will run on.
        async def restore() -> Workspace:
            async with registry.restoring() as policies:
                restored.extend(policies)
                ws = await run_with_network(
                    rule,
                    Workspace.load(
                        source,
                        mounts=mounts,
                        secrets=secrets,
                        s3=store,
                        max_snapshot_bytes=MAX_SNAPSHOT_BYTES,
                        max_snapshot_encoded_bytes=MAX_SNAPSHOT_PART,
                        policies=policies,
                        ceilings=registry.ceilings,
                    ),
                )
            past = _past_session_cap(ws, registry.max_sessions, "the snapshot")
            if past is not None:
                await ws.close()
                raise ValueError(past)
            return ws

        try:
            runner = await WorkspaceRunner.build(restore())
        except PolicyDenied as e:
            raise HttpError(
                ErrorCode.POLICY_REFUSED,
                e.refusal.reason if e.refusal is not None else str(e),
                refusal=refusal_to_dict(e.refusal),
            )
        except FileNotFoundError:
            raise HttpError(
                ErrorCode.INVALID_VALUE,
                "key names no snapshot",
                param="key",
            )
        except (SecretsError, ValueError, KeyError) as e:
            # A secrets override naming an unknown source, or one whose
            # optional dependency is absent, is a bad request like any
            # other override the deployment got wrong; so is an upload
            # that is not a snapshot.
            raise refused_build(e, "snapshot could not be loaded")
        try:
            entry = registry.add(
                runner,
                workspace_id=wid,
                owner=request.state.account,
                restored_with=restored,
            )
        except ValueError as e:
            await runner.stop()
            raise HttpError(ErrorCode.CONFLICT, str(e))
        await registry.drop_config(wid)
    return await make_detail(entry)


def _snapshot_store(request: Request) -> S3Config:
    """The S3-like store the server was given for snapshots.

    Args:
        request (Request): the request, for the app's store.

    Returns:
        S3Config: the store.

    Raises:
        HttpError: 400 when the server has none.
    """
    store: S3Config | None = request.app.state.snapshot_store
    if store is None:
        raise HttpError(
            ErrorCode.INVALID_REQUEST, "this server has no snapshot store"
        )
    return store


def _parse_load_request(body: bytes) -> LoadWorkspaceRequest:
    try:
        data = json.loads(body or b"{}")
    except ValueError as e:
        raise HttpError(ErrorCode.INVALID_JSON, "body must be JSON") from e
    try:
        return LoadWorkspaceRequest.model_validate(data)
    except ValidationError as e:
        raise validation_error(e.errors(include_url=False)) from e


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
        HttpError: 400 for a body without both parts, or with a
            ``key``; 413 for an oversized part.
    """
    name = b""
    body = bytearray()
    tar = io.BytesIO()
    seen: set[bytes] = set()
    async for event, data in part_events(request.stream(), content_type):
        if event is PartEvent.BEGIN:
            name = data
            # The daemon routes a load by its first request part alone.
            if name == b"request" and name in seen:
                raise HttpError(
                    ErrorCode.INVALID_REQUEST,
                    "multipart body has more than one 'request' part",
                )
            seen.add(name)
        elif event is PartEvent.DATA and name == b"request":
            body += data
            if len(body) > MAX_REQUEST_PART:
                raise HttpError(ErrorCode.TOO_LARGE, "request part too large")
        elif event is PartEvent.DATA and name == b"snapshot":
            tar.write(data)
            if tar.tell() > MAX_SNAPSHOT_PART:
                raise HttpError(ErrorCode.TOO_LARGE, "snapshot part too large")
    if b"snapshot" not in seen:
        raise HttpError(
            ErrorCode.INVALID_REQUEST, "multipart body missing 'snapshot' part"
        )
    req = _parse_load_request(bytes(body))
    if req.key is not None:
        raise HttpError(
            ErrorCode.INVALID_REQUEST,
            "load takes a 'key' or an uploaded 'snapshot', not both",
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
