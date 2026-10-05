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
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any
from urllib.parse import quote

import typer

from mirage.cli.client import DaemonUnreachable, make_client
from mirage.cli.output import fail, handle_response
from mirage.cli.workspace import resolve_config
from mirage.server.workspace_config import resolve_workspace_config

MCP_ENV_NAMES = ("MIRAGE_MCP_CONFIG", "MIRAGE_CONFIG")


def resolve_mcp_config(
    config: str | None = None,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
) -> Path:
    """Find the config `mirage mcp` should serve.

    Args:
        config (str | None): explicit path, relative to cwd.
        cwd (str | Path | None): directory to resolve from.
        env (dict[str, str] | None): environment mapping to read.

    Returns:
        Path: the resolved config path.
    """
    return resolve_workspace_config(
        config, cwd=cwd, env=env, env_names=MCP_ENV_NAMES
    )


def has_session(workspace_path: str, session_id: str) -> bool:
    """Whether a daemon workspace holds a session.

    Args:
        workspace_path (str): the workspace's ``/v1/workspaces/{id}``.
        session_id (str): the session.

    Returns:
        bool: True when the workspace lists the session.
    """
    with make_client() as client:
        rows = handle_response(
            client.request("GET", f"{workspace_path}/sessions")
        )
    return any(
        isinstance(row, dict) and row.get("session_id") == session_id
        for row in rows
    )


def mcp_cmd(
    config: str | None = typer.Argument(
        None, help="Mirage workspace YAML config."
    ),
    workspace_id: str | None = typer.Option(
        None,
        "--workspace_id",
        "--workspace",
        "-w",
        help="Serve this daemon workspace instead of loading a config.",
    ),
    session_id: str | None = typer.Option(
        None,
        "--session_id",
        "--session",
        "-s",
        help="Session the tools act as; the workspace's default when absent.",
    ),
) -> None:
    """Serve a Mirage workspace's MCP tools over stdio.

    The tools are the daemon's: this relays stdio to the workspace's
    ``/v1/workspaces/{id}/mcp`` endpoint, starting the daemon when it is
    not running. A config with no ``workspace_id`` makes a workspace that
    lives as long as this process, as a stdio server's state does. A
    workspace with a name, the config's ``workspace_id`` or
    ``--workspace``, outlives it. The daemon answers a config's name with
    the live workspace created from that same config, and refuses it when
    the live one came from another. ``--session`` serves the tools as
    that session, under its profile, as it does for ``mirage shell``.
    """
    if workspace_id is None:
        try:
            path: Path | None = resolve_mcp_config(config)
        except FileNotFoundError as e:
            fail(str(e), exit_code=2)
    elif config is not None:
        fail("pass a config or --workspace, not both", exit_code=2)
    else:
        path = None
    from mirage.server.mcp.relay import relay_stdio

    relay_workspace(path, workspace_id, session_id, "mcp", relay_stdio)


def relay_workspace(
    path: Path | None,
    workspace_id: str | None,
    session_id: str | None,
    endpoint: str,
    relay: Callable[[str, Callable[[], str]], Coroutine[Any, Any, None]],
) -> None:
    """Relay this process's stdio to one of a workspace's endpoints.

    The workspace is created from ``path``, or ``workspace_id`` names one
    the daemon holds; a created workspace with no ``workspace_id`` in its
    config is deleted when the relay ends, with the last token the relay
    sent, so a login that ended or changed meanwhile still removes it. A
    named session must exist.

    Args:
        path (Path | None): the config to create the workspace from.
        workspace_id (str | None): the daemon workspace to serve instead.
        session_id (str | None): the session to act as; None is the
            workspace's default.
        endpoint (str): ``mcp`` or ``rpc``, the route to relay to.
        relay (Callable[[str, Callable[[], str]], Coroutine[Any, Any, None]]):
            relays stdio to a URL, asking for the bearer token on every
            request.
    """
    minted = False
    with make_client() as client:
        try:
            client.ensure_running()
        except DaemonUnreachable as e:
            fail(str(e))
        if path is not None:
            body = {"config": resolve_config(path)}
            created = handle_response(
                client.request("POST", "/v1/workspaces", json=body)
            )
            if not isinstance(created, dict):
                fail(f"unexpected daemon response: {created!r}")
            workspace_id = str(created["id"])
            minted = not body["config"].get("workspace_id")
        else:
            handle_response(
                client.request(
                    "GET",
                    f"/v1/workspaces/{quote(str(workspace_id), safe='')}",
                )
            )
        workspace_path = f"/v1/workspaces/{quote(str(workspace_id), safe='')}"
        url = f"{client.settings.url}{workspace_path}/{endpoint}"
        if session_id is not None:
            url += f"?session_id={quote(session_id, safe='')}"
        token = client.token
    try:
        if session_id is not None and not has_session(
            workspace_path, session_id
        ):
            fail(f"session not found: {session_id}", exit_code=2)
        asyncio.run(relay(url, token))
    finally:
        if minted:
            with make_client() as cleanup:
                if client.held:
                    cleanup.settings.auth_token = client.held
                cleanup.request("DELETE", workspace_path)
