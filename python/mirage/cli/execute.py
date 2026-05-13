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
import sys

import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, exit_code_from_response, handle_response

app = typer.Typer(invoke_without_command=True, help="Execute a command.")


@app.callback(invoke_without_command=True)
def execute_cmd(
    workspace_id: str = typer.Option(...,
                                     "--workspace_id",
                                     "--workspace",
                                     "-w",
                                     help="Workspace id."),
    command: str = typer.Option(...,
                                "--command",
                                "-c",
                                help="Shell command to execute."),
    session_id: str | None = typer.Option(None,
                                          "--session_id",
                                          "--session",
                                          "-s",
                                          help="Session id."),
    background: bool = typer.Option(
        False,
        "--background",
        "--bg",
        help="Don't wait; return job_id immediately.",
    ),
) -> None:
    """Execute a command in a workspace.

    For dry-run / cost-estimate output, use ``mirage provision``
    instead.
    """
    payload: dict = {"command": command, "provision": False}
    if session_id:
        payload["session_id"] = session_id
    path = f"/v1/workspaces/{workspace_id}/execute"
    if background:
        path += "?background=true"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        if not sys.stdin.isatty() and not background:
            stdin_bytes = sys.stdin.buffer.read()
            files = {
                "request":
                ("request.json", json.dumps(payload), "application/json"),
                "stdin":
                ("stdin.bin", stdin_bytes, "application/octet-stream"),
            }
            r = client.request("POST", path, files=files)
        else:
            r = client.request("POST", path, json=payload)
    response = handle_response(r)
    emit(response)
    raise typer.Exit(code=exit_code_from_response(response))
