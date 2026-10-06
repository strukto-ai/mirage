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
import json
import logging
from collections.abc import Awaitable, Callable, Coroutine, Mapping
from functools import partial
from typing import Any, TypeGuard, TypeVar

import jsonschema

from mirage import __version__
from mirage.errors.classify import classify, failure_text
from mirage.errors.types import FsCondition
from mirage.server.io_serde import explanation_to_dict, io_result_to_dict
from mirage.server.mcp.server import TOOLS
from mirage.server.rpc.constants import (
    RPC_INTERNAL_ERROR,
    RPC_INVALID_PARAMS,
    RPC_INVALID_REQUEST,
    RPC_METHOD_NOT_FOUND,
    RPC_NOT_FOUND,
    RPC_PARSE_ERROR,
    VFS_OPS,
)
from mirage.types import JsonValue
from mirage.workspace.tools.tool_operations import MirageToolOperations
from mirage.workspace.workspace import Workspace
from mirage.workspace.workspace.handle import Session

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = "1"
CANCEL_REQUEST = "$/cancelRequest"
RPC_REQUEST_CANCELLED = -32800

T = TypeVar("T")
Params = Mapping[str, JsonValue]
Message = Mapping[str, JsonValue]
Response = dict[str, JsonValue]


class RpcError(Exception):
    """A JSON-RPC error answer.

    Args:
        code (int): the JSON-RPC error code.
        message (str): what went wrong.
        data (dict[str, JsonValue] | None): the structured detail.
    """

    def __init__(
        self,
        code: int,
        message: str,
        data: dict[str, JsonValue] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def error_response(
    request_id: JsonValue, code: int, message: str, data: JsonValue = None
) -> Response:
    """A JSON-RPC error response.

    Args:
        request_id (JsonValue): the request's id, or None.
        code (int): the error code.
        message (str): the message.
        data (JsonValue): the structured detail, if any.

    Returns:
        Response: the response.
    """
    error: dict[str, JsonValue] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def _text(params: Params, name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str):
        raise RpcError(RPC_INVALID_PARAMS, f"{name} must be a string")
    return value


def _integer(value: JsonValue) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _bytes(params: Params, name: str) -> bytes:
    try:
        return base64.b64decode(_text(params, name), validate=True)
    except ValueError as exc:
        raise RpcError(RPC_INVALID_PARAMS, f"{name} must be base64") from exc


def _vfs_args(
    op: str, params: Params
) -> tuple[tuple[Any, ...], dict[str, Any]]:
    """One op's arguments off its params, read the same way for
    ``vfs/<op>`` and its dry run ``explain/vfs/<op>``.

    Args:
        op (str): the op's name.
        params (Params): the request's params.
    """
    if op == "read":
        offset = params.get("offset", 0)
        size = params.get("size")
        if not _integer(offset):
            raise RpcError(RPC_INVALID_PARAMS, "offset must be an integer")
        if size is not None and not _integer(size):
            raise RpcError(RPC_INVALID_PARAMS, "size must be an integer")
        return (_text(params, "path"), offset, size), {}
    if op in ("write", "append"):
        return (_text(params, "path"), _bytes(params, "data_base64")), {}
    if op == "stat":
        nofollow = bool(params.get("nofollow", False))
        return (_text(params, "path"),), {"nofollow": nofollow}
    if op == "rename":
        return (_text(params, "src"), _text(params, "dst")), {}
    if op == "truncate":
        length = params.get("length")
        if not _integer(length):
            raise RpcError(RPC_INVALID_PARAMS, "length must be an integer")
        return (_text(params, "path"), length), {}
    return (_text(params, "path"),), {}


class MirageRpcServer:
    """Serves one session of a workspace over JSON-RPC 2.0.

    The methods are the in-app Session API under the same names: ``shell``
    is ``session.shell``, ``glob`` is ``session.glob``, ``vfs/<op>`` is
    ``session.vfs.<op>``, ``explain/shell`` and ``explain/vfs/<op>`` are
    their dry runs under ``session.explain``, and ``tools/list`` and
    ``tools/call`` serve the session's agent tool table with MCP's
    schemas. Bytes travel as base64. ``$/cancelRequest`` cancels a
    running request.

    Args:
        workspace (Workspace): the workspace to serve.
        session_id (str | None): the session the methods act as; None is
            the workspace's default session.
        operations (MirageToolOperations | None): the tool table to serve;
            the session's own (``session.tools``) when None.
        name (str): the server name ``initialize`` reports.
        version (str): the server version ``initialize`` reports.
    """

    def __init__(
        self,
        workspace: Workspace,
        session_id: str | None = None,
        operations: MirageToolOperations | None = None,
        name: str = "mirage",
        version: str = __version__,
    ) -> None:
        self._ws = workspace
        self._session_id = session_id or workspace.default_session_id
        self._session = Session(workspace, self._session_id)
        self._ops = (
            operations if operations is not None else self._session.tools
        )
        self._name = name
        self._version = version
        self._methods: dict[str, Callable[[Params], Awaitable[JsonValue]]] = {
            "initialize": self._initialize,
            "shell": self._shell,
            "glob": self._glob,
            "vfs/read": self._read,
            "vfs/write": self._write,
            "vfs/append": self._append,
            "vfs/stat": self._stat,
            "vfs/readdir": self._readdir,
            "vfs/exists": self._exists,
            "vfs/mkdir": self._mkdir,
            "vfs/rmdir": self._rmdir,
            "vfs/unlink": self._unlink,
            "vfs/rename": self._rename,
            "vfs/truncate": self._truncate,
            "explain/shell": self._explain_shell,
            **{
                f"explain/vfs/{op}": partial(self._explain_vfs, op)
                for op in VFS_OPS
            },
            "tools/list": self._tools_list,
            "tools/call": self._tools_call,
        }

    @property
    def session_id(self) -> str:
        """The session the methods act as."""
        return self._session_id

    @property
    def methods(self) -> list[str]:
        """Every method this server answers."""
        return list(self._methods)

    async def run_line(
        self,
        command: str,
        cwd: str | None,
        env: dict[str, str] | None,
        stdin: bytes | None,
    ) -> JsonValue:
        """Run one shell line in the session.

        Args:
            command (str): the line.
            cwd (str | None): a working directory for this line only.
            env (dict[str, str] | None): variables for this line only.
            stdin (bytes | None): the line's stdin.

        Returns:
            JsonValue: ``{kind, exit_code, stdout, stderr, refusal}``.
        """
        io = await self._session.shell(command, stdin=stdin, cwd=cwd, env=env)
        return await io_result_to_dict(io)

    async def hop(self, work: Coroutine[Any, Any, T]) -> T:
        """Run a Session call where the workspace lives.

        Args:
            work (Coroutine[Any, Any, T]): the call.

        Returns:
            T: its result.
        """
        return await work

    async def handle(self, message: Message) -> Response | None:
        """Answer one JSON-RPC message.

        Args:
            message (Message): a request or notification.

        Returns:
            Response | None: the response, or None for a notification.
        """
        request_id = message.get("id")
        method = message.get("method")
        if message.get("jsonrpc") != "2.0":
            if "id" not in message:
                return None
            return error_response(
                request_id, RPC_INVALID_REQUEST, 'jsonrpc must be "2.0"'
            )
        if not isinstance(method, str):
            if "id" not in message:
                return None
            return error_response(
                request_id, RPC_INVALID_REQUEST, "method must be a string"
            )
        if "id" not in message:
            return None
        handler = self._methods.get(method)
        if handler is None:
            return error_response(
                request_id, RPC_METHOD_NOT_FOUND, f"method not found: {method}"
            )
        params = message.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            return error_response(
                request_id, RPC_INVALID_PARAMS, "params must be an object"
            )
        try:
            result = await handler(params)
        except RpcError as exc:
            return error_response(request_id, exc.code, exc.message, exc.data)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("rpc %s failed", method, exc_info=True)
            condition = classify(exc)
            code = (
                RPC_NOT_FOUND
                if condition == FsCondition.ENOENT
                else RPC_INTERNAL_ERROR
            )
            data: dict[str, JsonValue] = {"detail": failure_text(exc)}
            if condition is not None:
                data["errno"] = condition.name
            return error_response(request_id, code, failure_text(exc), data)
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    async def serve(
        self,
        read_line: Callable[[], Awaitable[str]],
        write_line: Callable[[str], Awaitable[None]],
    ) -> None:
        """Answer newline-delimited JSON-RPC until the input ends.

        Each request runs as its own task, so a long ``shell`` does not
        hold the stream, answers go out as they finish, and
        ``$/cancelRequest`` reaches a running request, which then
        answers ``-32800``.

        Args:
            read_line (Callable[[], Awaitable[str]]): the next line, or
                an empty string at the end of input.
            write_line (Callable[[str], Awaitable[None]]): writes one
                serialized message and its newline.
        """
        running: dict[str, asyncio.Task[None]] = {}
        lock = asyncio.Lock()

        async def send(response: Response) -> None:
            async with lock:
                await write_line(json.dumps(response) + "\n")

        async def answer(message: Message, key: str) -> None:
            try:
                response = await self.handle(message)
            except asyncio.CancelledError:
                response = error_response(
                    message.get("id"),
                    RPC_REQUEST_CANCELLED,
                    "request cancelled",
                )
            finally:
                running.pop(key, None)
            if response is not None:
                await send(response)

        while line := await read_line():
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except ValueError:
                await send(
                    error_response(None, RPC_PARSE_ERROR, "parse error")
                )
                continue
            if not isinstance(message, dict):
                await send(
                    error_response(
                        None, RPC_INVALID_REQUEST, "a message is an object"
                    )
                )
                continue
            if message.get("method") == CANCEL_REQUEST:
                params = message.get("params")
                if isinstance(params, dict):
                    task = running.get(json.dumps(params.get("id")))
                    if task is not None:
                        task.cancel()
                continue
            key = json.dumps(message.get("id"))
            running[key] = asyncio.create_task(answer(message, key))
        if running:
            await asyncio.wait(list(running.values()))

    async def _initialize(self, params: Params) -> JsonValue:
        methods: list[JsonValue] = list(self._methods)
        return {
            "server_info": {"name": self._name, "version": self._version},
            "protocol_version": PROTOCOL_VERSION,
            "workspace_id": self._ws.workspace_id,
            "session_id": self._session_id,
            "methods": methods,
        }

    async def _shell(self, params: Params) -> JsonValue:
        cwd = params.get("cwd")
        env = params.get("env")
        if cwd is not None and not isinstance(cwd, str):
            raise RpcError(RPC_INVALID_PARAMS, "cwd must be a string")
        if env is not None and not (
            isinstance(env, dict)
            and all(isinstance(v, str) for v in env.values())
        ):
            raise RpcError(RPC_INVALID_PARAMS, "env must map names to strings")
        stdin = (
            _bytes(params, "stdin_base64")
            if "stdin_base64" in params
            else None
        )
        return await self.run_line(
            _text(params, "command"),
            cwd,
            {str(k): str(v) for k, v in env.items()} if env else None,
            stdin,
        )

    async def _glob(self, params: Params) -> JsonValue:
        paths = await self.hop(self._session.glob(_text(params, "pattern")))
        return {"paths": list(paths)}

    async def _read(self, params: Params) -> JsonValue:
        args, _ = _vfs_args("read", params)
        data = await self.hop(self._session.vfs.read(*args))
        return {"data_base64": base64.b64encode(data).decode()}

    async def _write(self, params: Params) -> JsonValue:
        args, _ = _vfs_args("write", params)
        await self.hop(self._session.vfs.write(*args))
        return {}

    async def _append(self, params: Params) -> JsonValue:
        args, _ = _vfs_args("append", params)
        await self.hop(self._session.vfs.append(*args))
        return {}

    async def _stat(self, params: Params) -> JsonValue:
        args, kwargs = _vfs_args("stat", params)
        stat = await self.hop(self._session.vfs.stat(*args, **kwargs))
        return stat.model_dump(mode="json", exclude={"extra"})

    async def _readdir(self, params: Params) -> JsonValue:
        names = await self.hop(
            self._session.vfs.readdir(_text(params, "path"))
        )
        return {"entries": list(names)}

    async def _exists(self, params: Params) -> JsonValue:
        found = await self.hop(self._session.vfs.exists(_text(params, "path")))
        return {"exists": found}

    async def _mkdir(self, params: Params) -> JsonValue:
        await self.hop(self._session.vfs.mkdir(_text(params, "path")))
        return {}

    async def _rmdir(self, params: Params) -> JsonValue:
        await self.hop(self._session.vfs.rmdir(_text(params, "path")))
        return {}

    async def _unlink(self, params: Params) -> JsonValue:
        await self.hop(self._session.vfs.unlink(_text(params, "path")))
        return {}

    async def _rename(self, params: Params) -> JsonValue:
        args, _ = _vfs_args("rename", params)
        await self.hop(self._session.vfs.rename(*args))
        return {}

    async def _truncate(self, params: Params) -> JsonValue:
        args, _ = _vfs_args("truncate", params)
        await self.hop(self._session.vfs.truncate(*args))
        return {}

    async def _explain_shell(self, params: Params) -> JsonValue:
        said = await self.hop(
            self._session.explain.shell(_text(params, "command"))
        )
        return explanation_to_dict(said)

    async def _explain_vfs(self, op: str, params: Params) -> JsonValue:
        args, kwargs = _vfs_args(op, params)
        explain = getattr(self._session.explain.vfs, op)
        return explanation_to_dict(await self.hop(explain(*args, **kwargs)))

    async def _tools_list(self, params: Params) -> JsonValue:
        names = await self._ops.offered()
        return {
            "tools": [
                tool.model_dump(mode="json", by_alias=True, exclude_none=True)
                for tool in TOOLS
                if tool.name in names
            ]
        }

    async def _tools_call(self, params: Params) -> JsonValue:
        name = _text(params, "name")
        tool = next((t for t in TOOLS if t.name == name), None)
        if tool is None or name not in await self._ops.offered():
            raise RpcError(RPC_INVALID_PARAMS, f"Tool {name} not found")
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict):
            raise RpcError(RPC_INVALID_PARAMS, "arguments must be an object")
        try:
            jsonschema.validate(arguments, tool.input_schema)
        except jsonschema.ValidationError as exc:
            raise RpcError(
                RPC_INVALID_PARAMS,
                f"Invalid arguments for tool {name}: {exc.message}",
            ) from exc
        result = await self._ops.call(name, arguments)
        return {"text": result.text, "is_error": result.is_error}
