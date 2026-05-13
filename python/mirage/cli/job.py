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

import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, exit_code_from_response, handle_response

app = typer.Typer(no_args_is_help=True, help="Manage daemon jobs.")


@app.command("list")
def list_cmd(
    workspace_id: str | None = typer.Option(
        None,
        "--workspace_id",
        "--workspace",
        "-w",
        help="Filter to one workspace.",
    ),
) -> None:
    path = "/v1/jobs"
    if workspace_id:
        path += f"?workspace_id={workspace_id}"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("GET", path)
    emit(handle_response(r))


@app.command("get")
def get_cmd(job_id: str = typer.Argument(...)) -> None:
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("GET", f"/v1/jobs/{job_id}")
    response = handle_response(r)
    emit(response)
    raise typer.Exit(code=exit_code_from_response(response))


@app.command("wait")
def wait_cmd(
    job_id: str = typer.Argument(...),
    timeout: float | None = typer.Option(
        None,
        "--timeout",
        help="Seconds to wait before returning a still-running snapshot.",
    ),
) -> None:
    body: dict = {}
    if timeout is not None:
        body["timeout_s"] = timeout
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST", f"/v1/jobs/{job_id}/wait", json=body)
    response = handle_response(r)
    emit(response)
    raise typer.Exit(code=exit_code_from_response(response))


@app.command("cancel")
def cancel_cmd(job_id: str = typer.Argument(...)) -> None:
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("DELETE", f"/v1/jobs/{job_id}")
    emit(handle_response(r))
