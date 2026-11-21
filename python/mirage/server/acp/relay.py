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
import base64
import itertools
import json
import logging
import os
import sys
from collections.abc import AsyncGenerator, AsyncIterable, Callable

import anyio
import httpx

from mirage.concurrency.limiter import run_blocking
from mirage.server.acp.constants import (
    ACP_INTERNAL_ERROR,
    ACP_INVALID_PARAMS,
    ACP_RESOURCE_NOT_FOUND,
    FILE_METHODS,
    FORK_SESSION,
    INITIALIZE,
    LINE_BREAK,
    LINE_LIMIT,
    NEW_SESSION,
    READ_TEXT_FILE,
    RPC_NOT_FOUND,
    RPC_TIMEOUT,
    SESSION_METHODS,
)
from mirage.server.acp.errors import WorkspaceCallError
from mirage.server.acp.types import HostWrite, WorkspaceCall
from mirage.server.env import trace_headers
from mirage.types import JsonObject, JsonValue

logger = logging.getLogger(__name__)


def with_files(params: JsonObject) -> JsonObject:
    """``initialize`` params that offer the agent the client's file
    methods, which the relay answers from the workspace.

    Args:
        params (JsonObject): the client's ``initialize`` params.
    """
    held = params.get("clientCapabilities")
    capabilities = dict(held) if isinstance(held, dict) else {}
    files = capabilities.get("fs")
    offered = dict(files) if isinstance(files, dict) else {}
    offered["readTextFile"] = True
    offered["writeTextFile"] = True
    capabilities["fs"] = offered
    return {**params, "clientCapabilities": capabilities}


def with_mirage(params: JsonObject, server: JsonObject) -> JsonObject:
    """Session params that hand the agent the workspace's MCP server.

    A server of the same name the client sent is replaced. Claude's ACP
    adapter also reads ``_meta.claudeCode.options``: an empty ``tools``
    there turns its built-in tools off, so it works through the
    workspace's tools, unless the client set its own.

    Args:
        params (JsonObject): the client's session params.
        server (JsonObject): the workspace's MCP server, as ACP's
            ``McpServerStdio``.
    """
    sent = params.get("mcpServers")
    kept: list[JsonValue] = [
        one
        for one in (sent if isinstance(sent, list) else [])
        if not (isinstance(one, dict) and one.get("name") == server["name"])
    ]
    held = params.get("_meta")
    meta = dict(held) if isinstance(held, dict) else {}
    claude = meta.get("claudeCode")
    adapter = dict(claude) if isinstance(claude, dict) else {}
    given = adapter.get("options")
    options = dict(given) if isinstance(given, dict) else {}
    options.setdefault("tools", [])
    adapter["options"] = options
    meta["claudeCode"] = adapter
    return {**params, "mcpServers": [*kept, server], "_meta": meta}


def workspace_path(path: str, cwd: str | None, root: str) -> str:
    """Where an agent's absolute path lands in the workspace: under
    ``root`` for a path in the session's folder, as given otherwise.

    Args:
        path (str): the path the agent asked for.
        cwd (str | None): the session's folder on the client, None when
            unknown.
        root (str): the workspace path that folder stands for.
    """
    if cwd is not None:
        base = cwd.rstrip("/")
        if path == (base or "/"):
            return root
        if path.startswith(base + "/"):
            return root.rstrip("/") + path[len(base) :]
    return path


def text_slice(text: str, line: int | None, limit: int | None) -> str:
    """The lines ACP's ``line`` (1-based) and ``limit`` pick from a file,
    each ending at CRLF, CR or LF.

    Args:
        text (str): the file's text.
        line (int | None): the first line, 1-based; None reads from the
            top.
        limit (int | None): at most this many lines; None reads to the
            end.
    """
    if line is None and limit is None:
        return text
    parts = LINE_BREAK.split(text)
    lines = [a + b for a, b in zip(parts[::2], parts[1::2], strict=False)]
    if parts[-1]:
        lines.append(parts[-1])
    start = max(line - 1, 0) if line is not None else 0
    end = start + limit if limit is not None else None
    return "".join(lines[start:end])


def _parse(line: str) -> JsonValue:
    try:
        parsed: JsonValue = json.loads(line)
    except ValueError as exc:
        logger.debug("acp line is not JSON: %s", exc)
        return None
    return parsed


class AgentRelay:
    """One ACP agent between its client and a workspace.

    Every message passes through unchanged but three: ``initialize``
    offers the agent the client's file methods, a session request hands
    it the workspace's MCP server, and the agent's file requests are
    answered from the workspace, never reaching the client.

    Args:
        agent (asyncio.subprocess.Process): the agent, its stdin and
            stdout piped.
        call (WorkspaceCall): calls the workspace's RPC.
        server (JsonObject): the workspace's MCP server for each session.
        root (str): the workspace path a session's folder stands for.
        host_write (HostWrite): writes a line to the client.
    """

    def __init__(
        self,
        agent: asyncio.subprocess.Process,
        call: WorkspaceCall,
        server: JsonObject,
        root: str,
        host_write: HostWrite,
    ) -> None:
        self._agent = agent
        self._call = call
        self._server = server
        self._root = root
        self._host_write = host_write
        self._lock = asyncio.Lock()
        self._folders: dict[str, str] = {}
        self._opening: dict[str, str] = {}
        self._answers: set[asyncio.Task[None]] = set()

    async def from_host(self, line: str) -> None:
        """Pass one client line to the agent, rewriting ``initialize``
        and the session requests.

        Args:
            line (str): the line, without its newline.
        """
        message = _parse(line)
        if isinstance(message, dict) and "id" in message:
            method = message.get("method")
            params = message.get("params")
            if method == INITIALIZE and isinstance(params, dict):
                line = json.dumps({**message, "params": with_files(params)})
            elif method in SESSION_METHODS and isinstance(params, dict):
                folder = params.get("cwd")
                session = params.get("sessionId")
                if isinstance(folder, str):
                    if method in (NEW_SESSION, FORK_SESSION):
                        self._opening[json.dumps(message["id"])] = folder
                    elif isinstance(session, str):
                        self._folders[session] = folder
                line = json.dumps(
                    {**message, "params": with_mirage(params, self._server)}
                )
        await self._to_agent(line)

    async def from_agent(self, line: str) -> None:
        """Answer one agent line's file request from the workspace, or
        pass the line to the client.

        Args:
            line (str): the line, without its newline.
        """
        message = _parse(line)
        if isinstance(message, dict):
            if message.get("method") in FILE_METHODS and "id" in message:
                task = asyncio.create_task(self._answer(message))
                self._answers.add(task)
                task.add_done_callback(self._answers.discard)
                return
            if "method" not in message and "id" in message:
                folder = self._opening.pop(json.dumps(message["id"]), None)
                result = message.get("result")
                if folder is not None and isinstance(result, dict):
                    session = result.get("sessionId")
                    if isinstance(session, str):
                        self._folders[session] = folder
        await self._host_write(line)

    async def close(self) -> None:
        """Wait for the file answers still running."""
        if self._answers:
            await asyncio.gather(*self._answers, return_exceptions=True)

    async def _answer(self, message: JsonObject) -> None:
        held = message.get("params")
        params = held if isinstance(held, dict) else {}
        reply: JsonObject
        try:
            result = await (
                self._read(params)
                if message.get("method") == READ_TEXT_FILE
                else self._write(params)
            )
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": result}
        except WorkspaceCallError as e:
            code = (
                ACP_RESOURCE_NOT_FOUND
                if e.code == RPC_NOT_FOUND
                else ACP_INVALID_PARAMS
                if e.code == ACP_INVALID_PARAMS
                else ACP_INTERNAL_ERROR
            )
            reply = {
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {"code": code, "message": e.message},
            }
        except Exception as exc:
            logger.debug("acp file request failed: %r", exc)
            reply = {
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {"code": ACP_INTERNAL_ERROR, "message": str(exc)},
            }
        await self._to_agent(json.dumps(reply))

    def _path(self, params: JsonObject) -> str:
        path = params.get("path")
        if not isinstance(path, str) or not path.startswith("/"):
            raise WorkspaceCallError(
                ACP_INVALID_PARAMS, "path must be an absolute path"
            )
        session = params.get("sessionId")
        folder = (
            self._folders.get(session) if isinstance(session, str) else None
        )
        return workspace_path(path, folder, self._root)

    async def _read(self, params: JsonObject) -> JsonObject:
        found = await self._call("vfs/read", {"path": self._path(params)})
        data = found.get("data") if isinstance(found, dict) else None
        if not isinstance(data, str):
            raise WorkspaceCallError(
                ACP_INTERNAL_ERROR, "the workspace answered no data"
            )
        text = base64.b64decode(data).decode("utf-8", errors="replace")
        line = params.get("line")
        limit = params.get("limit")
        return {
            "content": text_slice(
                text,
                line if isinstance(line, int) else None,
                limit if isinstance(limit, int) else None,
            )
        }

    async def _write(self, params: JsonObject) -> JsonObject:
        content = params.get("content")
        if not isinstance(content, str):
            raise WorkspaceCallError(ACP_INVALID_PARAMS, "content is required")
        data = base64.b64encode(content.encode()).decode()
        await self._call(
            "vfs/write", {"path": self._path(params), "data": data}
        )
        return {}

    async def _to_agent(self, line: str) -> None:
        stdin = self._agent.stdin
        if stdin is None:
            return
        async with self._lock:
            try:
                stdin.write(line.encode() + b"\n")
                await stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                logger.debug("acp agent stopped reading: %s", exc)


async def relay_agent(
    argv: list[str],
    call: WorkspaceCall,
    server: JsonObject,
    root: str,
    host_lines: AsyncIterable[str],
    host_write: HostWrite,
) -> int:
    """Run an ACP agent and relay its client's lines through it.

    Args:
        argv (list[str]): the agent's command line.
        call (WorkspaceCall): calls the workspace's RPC.
        server (JsonObject): the workspace's MCP server for each session.
        root (str): the workspace path a session's folder stands for.
        host_lines (AsyncIterable[str]): the client's lines.
        host_write (HostWrite): writes a line to the client.

    Returns:
        int: the agent's exit status, 128 plus the signal for one a
        signal ended.

    Raises:
        FileNotFoundError: no program ``argv[0]``.
    """
    agent = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        limit=LINE_LIMIT,
    )
    relay = AgentRelay(agent, call, server, root, host_write)

    async def pump() -> None:
        async for line in host_lines:
            text = line.rstrip("\r\n")
            if text.strip():
                await relay.from_host(text)
        if agent.stdin is not None:
            agent.stdin.close()

    client = asyncio.create_task(pump())
    try:
        stdout = agent.stdout
        while stdout is not None and (raw := await stdout.readline()):
            text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if text.strip():
                await relay.from_agent(text)
        status = await agent.wait()
    finally:
        client.cancel()
        await asyncio.gather(client, return_exceptions=True)
        if agent.returncode is None:
            agent.kill()
            await agent.wait()
        await relay.close()
    return status if status >= 0 else 128 - status


async def relay_stdio(
    argv: list[str],
    url: str,
    token: Callable[[], str],
    server: JsonObject,
    root: str,
) -> int:
    """Relay this process's ACP client to an agent, its files the
    workspace's.

    Args:
        argv (list[str]): the agent's command line.
        url (str): the workspace's ``/v1/workspaces/{id}/rpc`` URL.
        token (Callable[[], str]): the bearer token, asked for on every
            request, so a login refreshed while the relay runs is sent;
            empty sends none.
        server (JsonObject): the workspace's MCP server for each session.
        root (str): the workspace path a session's folder stands for.

    Returns:
        int: the agent's exit status.
    """

    class Bearer(httpx.Auth):
        async def async_auth_flow(
            self, request: httpx.Request
        ) -> AsyncGenerator[httpx.Request, httpx.Response]:
            value = await run_blocking(token)
            if value:
                request.headers["Authorization"] = f"Bearer {value}"
            yield request

    ids = itertools.count(1)
    lock = asyncio.Lock()

    async def write(line: str) -> None:
        async with lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    async with httpx.AsyncClient(
        auth=Bearer(), headers=trace_headers(os.environ), timeout=None
    ) as http:

        async def call(method: str, params: JsonObject) -> JsonValue:
            try:
                async with asyncio.timeout(RPC_TIMEOUT):
                    response = await http.post(
                        url,
                        json={
                            "jsonrpc": "2.0",
                            "id": next(ids),
                            "method": method,
                            "params": params,
                        },
                    )
            except (httpx.HTTPError, TimeoutError) as exc:
                logger.debug("acp workspace call failed: %r", exc)
                raise WorkspaceCallError(
                    ACP_INTERNAL_ERROR,
                    "the workspace did not answer in time"
                    if isinstance(exc, TimeoutError)
                    else f"the workspace is unreachable: {exc}",
                ) from exc
            try:
                body = response.json()
            except ValueError as exc:
                raise WorkspaceCallError(
                    ACP_INTERNAL_ERROR, f"error {response.status_code}"
                ) from exc
            error = body.get("error") if isinstance(body, dict) else None
            if isinstance(error, dict):
                code = error.get("code")
                raise WorkspaceCallError(
                    code if isinstance(code, int) else ACP_INTERNAL_ERROR,
                    str(error.get("message", "")),
                )
            if response.status_code >= 400 or not isinstance(body, dict):
                raise WorkspaceCallError(
                    ACP_INTERNAL_ERROR, f"error {response.status_code}"
                )
            result: JsonValue = body.get("result")
            return result

        async with anyio.wrap_file(sys.stdin) as stdin:
            return await relay_agent(argv, call, server, root, stdin, write)
