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
from collections.abc import Mapping
from contextlib import aclosing
from typing import cast
from urllib.parse import urlsplit

from mirage.accessor.github import GitHubAccount
from mirage.commands.builtin.utils.http import DEFAULT_PORTS
from mirage.commands.cli.builtin.gh.constants import (
    CONNECT_HINT,
    GITHUB_HOST,
)
from mirage.commands.cli.cobra import cobra_refusal, sets_value_flag
from mirage.commands.config import Context
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.core.github.client import (
    GitHubApiError,
    GitHubConnectionError,
    github_raw_response,
)
from mirage.core.github.constants import API_BASE
from mirage.core.jq import (
    Ending,
    Engine,
    JqCompileError,
    JqError,
    JqHalt,
    local_zone,
)
from mirage.errors.fs import fs_strerror
from mirage.io.memory import check_memory
from mirage.io.spool import ByteSpool
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import (
    Served,
    close_stream,
    open_stream,
    serve_requests,
)
from mirage.shell.bytes import encode_text
from mirage.types import JsonValue, PathSpec
from mirage.utils.clock import system_now
from mirage.version import __version__


def check_host(accessor: GitHubAccount, host: str | None) -> None:
    """Refuse a repository on a host this install cannot reach, in gh's
    words.

    Args:
        accessor (GitHubAccount): the install's account.
        host (str | None): the host the argument named, if any.

    Raises:
        ValueError: the host is not one this install answers.
    """
    if host is None:
        return
    host = host.lower()
    if host == GITHUB_HOST or host.endswith(f".{GITHUB_HOST}"):
        return
    base = accessor.config.base_url
    if base and urlsplit(base).hostname == host:
        return
    raise ValueError(f"error connecting to {host}\n{CONNECT_HINT}")


def web_origin(accessor: GitHubAccount) -> str:
    """The origin the install's GitHub serves its pages and git from:
    github.com for GitHub's own API, else the API host's own origin.

    Args:
        accessor (GitHubAccount): the install's account.

    Raises:
        ValueError: the API base is not an http(s) URL with a host.
    """
    base = accessor.config.base_url
    if base is None or base.rstrip("/") == API_BASE:
        return f"https://{GITHUB_HOST}"
    try:
        parts = urlsplit(base)
        host, port = parts.hostname, parts.port
    except ValueError as exc:
        raise ValueError("Invalid URL") from exc
    if parts.scheme not in {"http", "https"} or not host:
        raise ValueError("Invalid URL")
    if ":" in host:
        host = f"[{host}]"
    if port is None or port == DEFAULT_PORTS[parts.scheme]:
        return f"{parts.scheme}://{host}"
    return f"{parts.scheme}://{host}:{port}"


async def read_cli_file(ctx: Context, raw: FlagValue, option: str) -> bytes:
    """Read a path-valued CLI option from the VFS, or `-` from stdin.

    Args:
        ctx (Context): the command's context.
        raw (FlagValue): the path, as the flag holds it or as typed.
        option (str): the option, for its diagnostics.
    """
    if not isinstance(raw, (str, PathSpec)):
        raise ValueError(f"{option} expects a file")
    path = raw.raw_path if isinstance(raw, PathSpec) else raw
    if path == "-":
        if ctx.stdin is None:
            raise ValueError(f"{option} needs standard input")
        return await materialize(ctx.stdin)
    spec = PathSpec.from_str_path(raw, cwd=ctx.cwd)
    if ctx.vfs is None:
        raise ValueError(f"{option} needs a workspace to read files from")
    try:
        return await ctx.vfs.read(spec)
    except (FileNotFoundError, NotADirectoryError) as exc:
        reason = (fs_strerror(exc) or str(exc)).lower()
        raise ValueError(f"open {path}: {reason}") from None


class GhHost:
    """What a gh stream asks its host for: GitHub calls, the files its
    options name, its `--jq` programs, and how it ended.

    Args:
        accessor (GitHubAccount): the install's account.
        ctx (Context): the command's context.
    """

    def __init__(self, accessor: GitHubAccount, ctx: Context) -> None:
        self.accessor = accessor
        self.ctx = ctx
        self.errors = ByteSpool()
        self.failure: Mapping[str, JsonValue] | None = None

    async def _http(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        pairs = {
            name: dict(cast(list[tuple[str, str]], request[name]))
            for name in ("params", "headers")
        }
        method, path = str(request["method"]), str(request["path"])
        try:
            if request.get("has_body"):
                response = await github_raw_response(
                    self.accessor,
                    method,
                    path,
                    data if request.get("raw_body") else json.loads(data),
                    pairs["params"] or None,
                    headers=pairs["headers"] or None,
                )
            else:
                response = await github_raw_response(
                    self.accessor,
                    method,
                    path,
                    params=pairs["params"] or None,
                    headers=pairs["headers"] or None,
                )
        except GitHubApiError as exc:
            return Served(
                {
                    "status": exc.status,
                    "headers": cast(JsonValue, exc.headers),
                    "url": exc.url,
                    "message": str(exc),
                },
                exc.body.encode(),
            )
        except GitHubConnectionError as exc:
            return Served({"error": str(exc)})
        return Served(
            {
                "status": response.status,
                "headers": cast(JsonValue, dict(response.headers)),
            },
            response.data,
        )

    async def _read_file(self, request: Mapping[str, JsonValue]) -> Served:
        flag = request.get("flag")
        raw = (
            self.ctx.flags[flag]
            if isinstance(flag, str)
            else cast(FlagValue, request["path"])
        )
        try:
            content = await read_cli_file(
                self.ctx, raw, str(request["option"])
            )
        except ValueError as exc:
            return Served({"error": str(exc)})
        return Served({}, content)

    async def _jq(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        env = self.ctx.env
        try:
            engine = Engine.open(
                str(request["program"]),
                json.dumps(dict(env or {})),
                local_zone(env),
            )
        except (JqCompileError, StreamRefusal) as exc:
            return Served({"error": str(exc)})
        ending = Ending()
        try:
            async with aclosing(engine.run(data.decode(), ending)) as texts:
                outputs = [text async for text in texts]
        finally:
            await engine.close()
        stop = ending.stop
        reply: dict[str, JsonValue] = {}
        if isinstance(stop, JqError):
            reply = {
                "kind": "error",
                "message": stop.text,
                "string": stop.string,
                "own": stop.own,
            }
        elif isinstance(stop, JqHalt):
            reply = {
                "kind": "halt",
                "message": stop.message,
                "string": stop.string,
            }
        return Served(reply, "\n".join(outputs).encode())

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        """Do one request.

        Args:
            request (Mapping[str, JsonValue]): what the stream asks.
            data (bytes): the bytes it carries.
        """
        op = request["op"]
        if op == "http":
            return await self._http(request, data)
        if op == "read_file":
            return await self._read_file(request)
        if op == "jq":
            return await self._jq(request, data)
        if op == "now":
            return Served({"now": system_now()})
        if op == "memory":
            check_memory(cast(int, request["size"]))
            return Served({})
        if op == "fail":
            self.failure = request
            return Served({})
        raise ValueError(f"gh: unknown host request {op}")


def masked_token(token: str) -> str:
    """The token as `gh auth status` shows it: its prefix, the rest starred.

    Args:
        token (str): the install's token.
    """
    prefix = token[: token.rfind("_") + 1]
    return prefix + "*" * (len(token) - len(prefix))


def _flag_value(value: FlagValue) -> JsonValue:
    if isinstance(value, PathSpec):
        return {"path": value.raw_path or value.virtual}
    return cast(JsonValue, value)


async def run_leaf(
    leaf: str,
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Run one subcommand's mirage-rs body, answering what it asks.

    Args:
        leaf (str): the subcommand's canonical path below gh.
        accessor (GitHubAccount): the install's account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the text operands.
        ctx (Context): the parsed flags and context.
    """
    config = accessor.config
    stream = open_stream(
        "gh",
        {
            "leaf": leaf,
            "flags": {
                name: _flag_value(value) for name, value in ctx.flags.items()
            },
            "texts": list(texts),
            "repo": config.repo,
            "branch": config.branch,
            "token_mask": masked_token(config.token.get_secret_value()),
            "base_url": config.base_url,
            "version": __version__,
            "argv_len": len(ctx.argv),
            "argv": list(ctx.argv),
            "value_flag": sets_value_flag(
                cast(CommandSpec, ctx.spec), ctx.argv
            ),
        },
    )
    host = GhHost(accessor, ctx)
    output = bytearray()
    try:
        async for chunk in serve_requests(stream, host):
            output.extend(chunk)
        status = stream.status()
        stderr = await host.errors.read(0, host.errors.size)
    finally:
        await host.errors.close()
        await close_stream(stream)
    failure = host.failure
    if failure is None:
        return bytes(output), IOResult(exit_code=status, stderr=stderr)
    message = str(failure["message"])
    if failure["kind"] == "usage":
        message = cobra_refusal(
            message, f"gh {leaf}", cast(CommandSpec, ctx.spec)
        )
    elif not message.endswith("\n"):
        message = f"{message}\n"
    return bytes(output), IOResult(
        exit_code=cast(int, failure["code"]), stderr=encode_text(message)
    )
