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
import importlib
import logging
import socket

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.responses import PlainTextResponse
from starlette.websockets import WebSocketState

from mirage.server.registry import WorkspaceRegistry
from mirage.server.ssh.constants import TUNNEL_CHUNK, TUNNEL_MODULE
from mirage.server.ssh.types import ServeTunnel, SSHTunnel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/workspaces")


@router.websocket("/{workspace_id}/ssh")
async def ssh_tunnel(websocket: WebSocket, workspace_id: str) -> None:
    """Carry one SSH connection to ``workspace_id`` over this WebSocket.

    The auth middleware has checked the caller's token; the account it
    names must be allowed the workspace, else the upgrade answers 404
    before any SSH. The login needs no key and may only name this
    workspace. ``ssh -o ProxyCommand="mirage ssh-proxy %r"`` reaches it.

    Args:
        websocket (WebSocket): the caller's connection.
        workspace_id (str): the workspace to log in to.
    """
    registry: WorkspaceRegistry = websocket.app.state.registry
    account = websocket.state.account
    if registry.visible(workspace_id, account) is None:
        await websocket.send_denial_response(
            PlainTextResponse("workspace not found", status_code=404)
        )
        return
    module_path, attr = TUNNEL_MODULE.split(":")
    try:
        module = importlib.import_module(module_path)
    except ModuleNotFoundError:
        await websocket.send_denial_response(
            PlainTextResponse(
                "SSH over HTTPS needs asyncssh; install the ssh extra "
                "(pip install 'mirage-ai[ssh]')",
                status_code=501,
            )
        )
        return
    serve: ServeTunnel = getattr(module, attr)
    await websocket.accept()
    ours, theirs = socket.socketpair()
    reader, writer = await asyncio.open_connection(sock=ours)
    login: asyncio.Task[SSHTunnel] = asyncio.create_task(
        serve(
            registry,
            websocket.app.state.ssh_config,
            theirs,
            workspace_id,
            account,
        )
    )

    async def inbound() -> None:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            data = message.get("bytes")
            if data is None:
                data = (message.get("text") or "").encode()
            writer.write(data)
            await writer.drain()

    async def outbound() -> None:
        while data := await reader.read(TUNNEL_CHUNK):
            await websocket.send_bytes(data)

    async def end() -> None:
        if not login.done():
            login.cancel()
        try:
            tunnel = await login
        except asyncio.CancelledError:
            logger.debug("ssh tunnel: ended before the login was in")
            return
        except (OSError, ValueError) as exc:
            logger.debug("ssh tunnel: login refused: %s", exc)
            return
        tunnel.close()
        await tunnel.wait_closed()

    relays = [asyncio.create_task(inbound()), asyncio.create_task(outbound())]
    try:
        _, pending = await asyncio.wait(
            relays, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in relays:
            try:
                await task
            except asyncio.CancelledError:
                logger.debug("ssh tunnel: one direction stopped first")
            except (OSError, RuntimeError, WebSocketDisconnect) as exc:
                logger.debug("ssh tunnel: relay ended: %s", exc)
    finally:
        writer.close()
        await end()
        theirs.close()
        if (
            websocket.client_state is WebSocketState.CONNECTED
            and websocket.application_state is WebSocketState.CONNECTED
        ):
            await websocket.close()
