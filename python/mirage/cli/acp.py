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

import shutil
import sys
from collections.abc import Callable
from pathlib import Path
from urllib.parse import unquote, urlsplit

import typer

from mirage.cli.mcp import MCP_ENV_NAMES, relay_workspace
from mirage.cli.output import fail
from mirage.types import JsonObject

ACP_SERVER_NAME = "mirage"


def workspace_of(url: str) -> str:
    """The workspace id in a ``/v1/workspaces/{id}/...`` URL.

    Args:
        url (str): a workspace endpoint's URL.
    """
    tail = urlsplit(url).path.rpartition("/v1/workspaces/")[2]
    return unquote(tail.split("/", 1)[0])


def mcp_server(workspace_id: str, session_id: str | None) -> JsonObject:
    """The workspace's MCP server as ACP's ``McpServerStdio``: this
    install's ``mirage mcp`` on the same workspace and session, the
    ``mirage`` script beside the interpreter, or the interpreter running
    the CLI module where there is none.

    Args:
        workspace_id (str): the workspace.
        session_id (str | None): the session; None is the default.
    """
    script = shutil.which("mirage", path=str(Path(sys.executable).parent))
    command, *lead = (
        [script] if script else [sys.executable, "-m", "mirage.cli.main"]
    )
    args = [*lead, "mcp", "--workspace", workspace_id]
    if session_id is not None:
        args += ["--session", session_id]
    return {
        "name": ACP_SERVER_NAME,
        "command": command,
        "args": list(args),
        "env": [],
    }


def acp_cmd(
    agent: list[str] = typer.Argument(
        ..., metavar="AGENT...", help="The ACP agent's command line."
    ),
    config: str | None = typer.Option(
        None, "--config", "-c", help="Mirage workspace YAML config."
    ),
    workspace_id: str | None = typer.Option(
        None,
        "--workspace",
        "-w",
        help="Serve this daemon workspace instead of loading a config.",
    ),
    session_id: str | None = typer.Option(
        None,
        "--session",
        "-s",
        help="Session the agent acts as; the workspace's default when absent.",
    ),
    root: str = typer.Option(
        "/",
        "--root",
        help="Workspace path the client's project folder stands for.",
    ),
) -> None:
    """Run an ACP agent on a Mirage workspace.

    For an ACP client such as Zed or t3code, in place of the agent's own
    command: ``mirage acp -w demo -- claude-agent-acp``. Every message
    passes through, but the agent's file reads and writes are answered
    from the workspace, each session gets the workspace's MCP tools, and
    Claude's built-in tools are turned off. A path in the session's folder
    lands under ``--root``. The workspace is the daemon's, as for
    ``mirage mcp``; the exit status is the agent's.
    """
    if workspace_id is not None and config is not None:
        fail("pass --config or --workspace, not both", exit_code=2)
    if not root.startswith("/"):
        fail("--root takes an absolute workspace path", exit_code=2)
    path: Path | None = None
    if workspace_id is None:
        from mirage.server.workspace_config import (  # noqa: PLC0415
            resolve_workspace_config,
        )

        try:
            path = resolve_workspace_config(config, env_names=MCP_ENV_NAMES)
        except FileNotFoundError as e:
            fail(str(e), exit_code=2)
    # Load the protocol relay only for this CLI verb.
    from mirage.server.acp.relay import relay_stdio  # noqa: PLC0415

    async def relay(url: str, token: Callable[[], str]) -> None:
        server = mcp_server(workspace_of(url), session_id)
        try:
            status = await relay_stdio(list(agent), url, token, server, root)
        except FileNotFoundError:
            fail(f"acp: {agent[0]}: command not found", exit_code=127)
        if status != 0:
            raise typer.Exit(status)

    relay_workspace(path, workspace_id, session_id, "rpc", relay)
