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

import json
import logging
from collections.abc import Awaitable, Callable

import jsonschema
from fastapi import APIRouter, HTTPException, Request
from mcp.server.transport_security import DEFAULT_MAX_REQUEST_BODY_SIZE
from pydantic import BaseModel

from mirage.server.mcp.server import TOOLS
from mirage.types import JsonValue

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/workspaces/{workspace_id}")

INPUTS: dict[str, dict[str, JsonValue]] = {
    tool.name: tool.input_schema for tool in TOOLS if tool.name != "shell"
}


class ToolResponse(BaseModel):
    text: str
    is_error: bool


async def call_tool(
    request: Request,
    workspace_id: str,
    name: str,
    session_id: str | None,
) -> ToolResponse:
    """Run one tool for an HTTP caller, as MCP runs it.

    The body is the tool's input, held to the MCP route's size limit and
    checked against the same schema MCP checks it against, so an input
    MCP takes is one this takes. The call goes to the table the MCP
    endpoint serves the session with, so a read over HTTP stamps the
    file for an edit over MCP and back.

    Args:
        request (Request): the HTTP request, carrying the body and the
            app's MCP door.
        workspace_id (str): the workspace.
        name (str): the tool.
        session_id (str | None): the session; None is the default.

    Returns:
        ToolResponse: the tool's text and whether it failed.
    """
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > DEFAULT_MAX_REQUEST_BODY_SIZE:
            raise HTTPException(
                status_code=413, detail="request body too large"
            )
    try:
        arguments = json.loads(body)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"Invalid JSON body for tool {name}"
        ) from exc
    try:
        jsonschema.validate(arguments, INPUTS[name])
    except jsonschema.ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid arguments for tool {name}: {exc.message}",
        ) from exc
    try:
        tools = await request.app.state.mcp.tools(
            workspace_id, session_id, request.state.account
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=exc.args[0]) from exc
    try:
        result = await tools.call(name, arguments)
    except Exception as exc:
        logger.debug("tool %s failed", name, exc_info=True)
        return ToolResponse(text=str(exc), is_error=True)
    return ToolResponse(text=result.text, is_error=result.is_error)


def tool_route(name: str) -> Callable[..., Awaitable[ToolResponse]]:
    """The endpoint for one tool.

    Args:
        name (str): the tool.

    Returns:
        Callable[..., Awaitable[ToolResponse]]: the route handler.
    """

    async def endpoint(
        workspace_id: str, request: Request, session_id: str | None = None
    ) -> ToolResponse:
        return await call_tool(request, workspace_id, name, session_id)

    return endpoint


for _name in INPUTS:
    router.add_api_route(
        f"/{_name}",
        tool_route(_name),
        methods=["POST"],
        response_model=ToolResponse,
    )
