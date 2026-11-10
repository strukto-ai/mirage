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
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from mcp.server.transport_security import DEFAULT_MAX_REQUEST_BODY_SIZE

from mirage.io.stream import close_quietly
from mirage.server.errors import (
    ErrorCode,
    HttpError,
    WorkspaceMissing,
    fs_error,
)
from mirage.server.io_serde import (
    CallArgsError,
    answered,
    checked,
    custom_answer,
)
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.vfs_calls import VFS_CALLS, VfsCall
from mirage.types import JsonValue
from mirage.workspace.workspace.workspace import Session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/workspaces/{workspace_id}")


def require_entry(request: Request, workspace_id: str) -> WorkspaceEntry:
    """The workspace a route names, as the caller may see it.

    Args:
        request (Request): the request, carrying the registry and the
            caller's account.
        workspace_id (str): the workspace.

    Raises:
        WorkspaceMissing: when the caller sees no such live workspace.
    """
    registry: WorkspaceRegistry = request.app.state.registry
    entry = registry.visible(workspace_id, request.state.account)
    if entry is None:
        raise WorkspaceMissing(workspace_id)
    return entry


async def session_of(entry: WorkspaceEntry, session_id: str | None) -> Session:
    """The session a call acts as: the one named, or the default.

    Args:
        entry (WorkspaceEntry): the workspace.
        session_id (str | None): the session; None is the default.

    Raises:
        HttpError: 404 when no such session exists.
    """
    ws = entry.runner.ws
    if not ws.sessions_loaded:
        await entry.runner.call(ws.ensure_sessions_loaded())
    if session_id and not any(
        s.session_id == session_id for s in ws.list_sessions()
    ):
        raise HttpError(ErrorCode.NOT_FOUND, "session not found")
    return Session(ws, session_id or None)


async def json_body(request: Request) -> dict[str, JsonValue]:
    """A request's JSON object, read up to the MCP route's size limit.

    Args:
        request (Request): the request.

    Raises:
        HttpError: 413 past the limit, 400 for anything but a JSON
            object.
    """
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > DEFAULT_MAX_REQUEST_BODY_SIZE:
            raise HttpError(ErrorCode.TOO_LARGE, "request body too large")
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict):
        raise HttpError(
            ErrorCode.INVALID_REQUEST, "body must be a JSON object"
        )
    return parsed


def failure(exc: Exception) -> JSONResponse:
    """A call's failure as the HTTP entry points answer it: the errno it names
    picks the status, and the body carries the errno, the text and, for
    a policy's refusal, its record.

    Args:
        exc (Exception): what the call raised.
    """
    return fs_error(exc).response()


async def streamed_read(
    entry: WorkspaceEntry, session: Session, args: dict[str, Any]
) -> Response:
    """A read answered as its bytes, pulled as the response is sent.

    Args:
        entry (WorkspaceEntry): the workspace.
        session (Session): the session the read acts as.
        args (dict[str, Any]): the read's checked arguments.
    """
    try:
        source = await entry.runner.call(session.vfs.read(**args, stream=True))
    except Exception as exc:
        logger.debug("vfs/read failed", exc_info=True)
        return failure(exc)

    async def pull() -> bytes:
        return await anext(source)

    async def output() -> AsyncIterator[bytes]:
        try:
            while True:
                try:
                    chunk = await entry.runner.call(pull())
                except StopAsyncIteration:
                    return
                yield chunk
        finally:
            await entry.runner.call(close_quietly(source))

    return StreamingResponse(
        output(),
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-store"},
    )


def vfs_route(call: VfsCall) -> Callable[..., Awaitable[Response]]:
    """The endpoint for one VFS call. A ``read`` that asks for ``stream``
    answers its bytes as they are pulled, over HTTP only, where the body
    can carry them raw.

    Args:
        call (VfsCall): the call.
    """

    async def endpoint(
        workspace_id: str,
        request: Request,
        session_id: str | None = None,
        explain: bool = False,
    ) -> Response:
        entry = require_entry(request, workspace_id)
        params = await json_body(request)
        stream = params.pop("stream", False) if call.name == "read" else False
        if not isinstance(stream, bool):
            raise HttpError(
                ErrorCode.INVALID_VALUE,
                "stream must be a boolean",
                param="stream",
            )
        try:
            args = checked(call, params)
        except CallArgsError as exc:
            raise exc.error() from exc
        session = await session_of(entry, session_id)
        if stream and not explain:
            return await streamed_read(entry, session, args)
        try:
            result = await entry.runner.call(
                answered(session, call, args, explain)
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("vfs/%s failed", call.name, exc_info=True)
            return failure(exc)
        return JSONResponse(content=result)

    return endpoint


for _call in VFS_CALLS:
    router.add_api_route(
        f"/vfs/{_call.name}", vfs_route(_call), methods=["POST"]
    )


@router.post("/vfs/{name}")
async def custom_function(
    workspace_id: str,
    name: str,
    request: Request,
    session_id: str | None = None,
) -> JSONResponse:
    """Call a declared VFS function using the ordinary session and policy gate."""
    entry = require_entry(request, workspace_id)
    params = await json_body(request)
    session = await session_of(entry, session_id)
    try:
        result = await entry.runner.call(custom_answer(session, name, params))
    except CallArgsError as exc:
        raise exc.error() from exc
    except Exception as exc:
        logger.debug("vfs/%s failed", name, exc_info=True)
        return failure(exc)
    return JSONResponse(content=result)
