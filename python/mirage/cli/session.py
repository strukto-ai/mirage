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
from mirage.cli.output import emit, handle_response

app = typer.Typer(no_args_is_help=True, help="Manage workspace sessions.")

_ROLES = ("read", "write", "exec", "r", "rw", "rwx")


def _parse_mount_grants(mounts: list[str]) -> dict[str, str]:
    """Parse ``-m`` values like ``/data:read`` into a grants mapping.

    Roles are the words ("read", "write", "exec") or their cumulative
    filesystem aliases ("r", "rw", "rwx"). A bare prefix (no role
    suffix) grants the mount its own configured mode. The role is taken
    from the last ``:`` so mount prefixes that contain colons still
    parse.

    Args:
        mounts (list[str]): raw ``-m`` option values.
    """
    grants: dict[str, str] = {}
    for item in mounts:
        prefix, sep, role = item.rpartition(":")
        if sep and role in _ROLES:
            grants[prefix] = role
        else:
            grants[item] = "exec"
    return grants


@app.command("create")
def create_cmd(
    workspace_id: str = typer.Argument(...),
    session_id: str | None = typer.Option(None,
                                          "--id",
                                          help="Explicit session id."),
    mount: list[str] = typer.Option(
        [],
        "--mount",
        "-m",
        help=("Restrict this session to a mount, optionally capping its "
              "role: '/data:read' (alias '/data:r'), '/scratch:rw', "
              "'/bin:rwx', or a bare '/data' to keep the mount's own "
              "mode. Repeat for multiple mounts; omit for unrestricted."),
    ),
) -> None:
    body: dict = {}
    if session_id:
        body["session_id"] = session_id
    if mount:
        body["mounts"] = _parse_mount_grants(mount)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/sessions",
                           json=body)
    emit(handle_response(r))


@app.command("list")
def list_cmd(workspace_id: str = typer.Argument(...)) -> None:
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("GET", f"/v1/workspaces/{workspace_id}/sessions")
    emit(handle_response(r))


@app.command("delete")
def delete_cmd(
        workspace_id: str = typer.Argument(...),
        session_id: str = typer.Argument(...),
) -> None:
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "DELETE", f"/v1/workspaces/{workspace_id}/sessions/{session_id}")
    emit(handle_response(r))
