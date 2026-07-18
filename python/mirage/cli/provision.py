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

from typing import Any

import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, handle_response

app = typer.Typer(invoke_without_command=True,
                  help="Estimate cost / preview a command without running it.")


@app.callback(invoke_without_command=True)
def provision_cmd(
    workspace_id: str = typer.Option(...,
                                     "--workspace_id",
                                     "--workspace",
                                     "-w",
                                     help="Workspace id."),
    command: str = typer.Option(...,
                                "--command",
                                "-c",
                                help="Shell command to estimate."),
    session_id: str | None = typer.Option(None,
                                          "--session_id",
                                          "--session",
                                          "-s",
                                          help="Session id."),
) -> None:
    """Dry-run a command and return its cost estimate.

    Returns a ``ProvisionResult`` shape (network bytes, cache hits,
    estimated cost) instead of actually running the command.
    """
    payload: dict[str, Any] = {"command": command, "provision": True}
    if session_id:
        payload["session_id"] = session_id
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "POST",
            f"/v1/workspaces/{workspace_id}/execute",
            json=payload,
        )
    emit(handle_response(r))
