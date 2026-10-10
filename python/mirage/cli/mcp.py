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
from dataclasses import replace
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import httpx
import typer

from mirage.cli.client import DaemonClient, DaemonUnreachable, make_client
from mirage.cli.credentials import LoginError
from mirage.cli.output import fail, handle_response
from mirage.cli.workspace import resolve_config
from mirage.server.workspace_config import resolve_workspace_config

MCP_ENV_NAMES = ("MIRAGE_MCP_CONFIG", "MIRAGE_CONFIG")


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
    all_calls: bool = typer.Option(
        False,
        "--all-calls",
        help="Also serve each VFS call as a tool, and explain.",
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
    ``--all-calls`` also serves each VFS call as a ``vfs_<call>`` tool,
    and ``explain`` on ``shell`` and on each of them.
    """
    if workspace_id is None:
        try:
            path: Path | None = resolve_workspace_config(
                config, env_names=MCP_ENV_NAMES
            )
        except FileNotFoundError as e:
            fail(str(e), exit_code=2)
    elif config is not None:
        fail("pass a config or --workspace, not both", exit_code=2)
    else:
        path = None
    from mirage.server.mcp.relay import relay_stdio

    relay_workspace(
        path, workspace_id, session_id, "mcp", relay_stdio, all_calls
    )


def delete_workspace(client: DaemonClient, workspace_id: str) -> None:
    """Delete a relay's temporary workspace on the relay's own server.

    Sends the token the relay last used, so it works after the login
    ended or changed and without a refresh; only when the server refuses
    that token does it ask the login for a fresh one and try once more.
    A delete that still fails is reported on stderr.

    Args:
        client (DaemonClient): the relay's client.
        workspace_id (str): the workspace.
    """
    path = f"/v1/workspaces/{quote(workspace_id, safe='')}"

    def attempt(bearer: str) -> httpx.Response:
        settings = replace(client.settings, auth_token=bearer, login=None)
        with DaemonClient(settings) as cleanup:
            return cleanup.request("DELETE", path)

    done = attempt(client.held)
    if done.status_code == 401 and client.settings.login is not None:
        try:
            done = attempt(client.token())
        except LoginError as e:
            typer.echo(
                f"could not delete workspace {workspace_id}: {e}", err=True
            )
            return
    if done.status_code >= 400:
        typer.echo(
            f"could not delete workspace {workspace_id}: "
            f"daemon error {done.status_code}",
            err=True,
        )


def relay_workspace(
    path: Path | None,
    workspace_id: str | None,
    session_id: str | None,
    endpoint: str,
    relay: Callable[[str, Callable[[], str]], Coroutine[Any, Any, None]],
    all_calls: bool = False,
) -> None:
    """Relay this process's stdio to one of a workspace's endpoints.

    The workspace is created from ``path``, or ``workspace_id`` names one
    the daemon holds; a created workspace with no ``workspace_id`` in its
    config is deleted when the relay ends (see ``delete_workspace``). A
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
        all_calls (bool): ask the MCP endpoint for the VFS calls too.
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
        query = {"session_id": session_id} if session_id is not None else {}
        if all_calls:
            query["calls"] = "all"
        if query:
            url += f"?{urlencode(query, quote_via=quote)}"
        token = client.token
    try:
        if session_id is not None and not has_session(
            workspace_path, session_id
        ):
            fail(f"session not found: {session_id}", exit_code=2)
        asyncio.run(relay(url, token))
    finally:
        if minted:
            delete_workspace(client, str(workspace_id))
