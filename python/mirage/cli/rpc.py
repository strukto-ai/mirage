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

from pathlib import Path

import typer

from mirage.cli.mcp import relay_workspace
from mirage.cli.output import fail
from mirage.server.workspace_config import resolve_workspace_config

RPC_ENV_NAMES = ("MIRAGE_RPC_CONFIG", "MIRAGE_CONFIG")


def resolve_rpc_config(
    config: str | None = None,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
) -> Path:
    """Find the config `mirage rpc` should serve.

    Args:
        config (str | None): explicit path, relative to cwd.
        cwd (str | Path | None): directory to resolve from.
        env (dict[str, str] | None): environment mapping to read.

    Returns:
        Path: the resolved config path.
    """
    return resolve_workspace_config(
        config, cwd=cwd, env=env, env_names=RPC_ENV_NAMES
    )


def rpc_cmd(
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
        help="Session the methods act as; the workspace's default when absent.",
    ),
) -> None:
    """Serve a workspace session's API over JSON-RPC on stdio.

    Line-delimited JSON-RPC 2.0 on stdin and stdout, relayed to the
    workspace's ``/v1/workspaces/{id}/rpc`` endpoint, as ``mirage mcp``
    relays MCP, with the same config, ``--workspace`` and ``--session``
    rules.
    """
    if workspace_id is None:
        try:
            path: Path | None = resolve_rpc_config(config)
        except FileNotFoundError as e:
            fail(str(e), exit_code=2)
    elif config is not None:
        fail("pass a config or --workspace, not both", exit_code=2)
    else:
        path = None
    from mirage.server.rpc.relay import relay_stdio

    relay_workspace(path, workspace_id, session_id, "rpc", relay_stdio)
