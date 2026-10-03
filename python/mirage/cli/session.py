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
from urllib.parse import quote

import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, handle_response

app = typer.Typer(no_args_is_help=True, help="Manage workspace sessions.")

_MODES = ("read", "write", "exec", "r", "rw", "rwx")


def _parse_mount_modes(mounts: list[str]) -> dict[str, str]:
    """Parse ``-m`` values like ``/data:read`` into a modes mapping.

    Modes are the words ("read", "write", "exec") or their cumulative
    filesystem aliases ("r", "rw", "rwx"). A bare prefix (no mode
    suffix) keeps the mount's own configured mode. The mode is taken
    from the last ``:`` so mount prefixes that contain colons still
    parse.

    Args:
        mounts (list[str]): raw ``-m`` option values.
    """
    modes: dict[str, str] = {}
    for item in mounts:
        prefix, sep, mode = item.rpartition(":")
        if sep and mode in _MODES:
            modes[prefix] = mode
        else:
            modes[item] = "exec"
    return modes


@app.command("create")
def create_cmd(
    workspace_id: str = typer.Argument(...),
    session_id: str | None = typer.Option(
        None, "--id", help="Explicit session id."
    ),
    mount: list[str] = typer.Option(
        [],
        "--mount",
        "-m",
        help=(
            "Narrow a mount's mode for this session: '/data:read' "
            "(alias '/data:r'), '/scratch:rw', '/bin:rwx', or a bare "
            "'/data' to keep the mount's own mode. Repeat per mount. "
            "This narrows only; a mount you do not name keeps its own "
            "mode, and keeping a session away from one is a hide in "
            "its profile."
        ),
    ),
    profile: str | None = typer.Option(
        None,
        "--profile",
        "-p",
        help=(
            "The profile this session runs under, by name from the "
            "workspace's profiles. A profile is the whole permission "
            "document; omit it to take the workspace default."
        ),
    ),
) -> None:
    body: dict[str, Any] = {}
    if session_id:
        body["session_id"] = session_id
    if mount:
        body["mounts"] = _parse_mount_modes(mount)
    if profile:
        body["profile"] = profile
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "POST",
            f"/v1/workspaces/{quote(workspace_id, safe='')}/sessions",
            json=body,
        )
    emit(handle_response(r))


@app.command("list")
def list_cmd(workspace_id: str = typer.Argument(...)) -> None:
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "GET", f"/v1/workspaces/{quote(workspace_id, safe='')}/sessions"
        )
    emit(handle_response(r))


@app.command("delete")
def delete_cmd(
    workspace_id: str = typer.Argument(...),
    session_id: str = typer.Argument(...),
) -> None:
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        wid = quote(workspace_id, safe="")
        sid = quote(session_id, safe="")
        r = client.request("DELETE", f"/v1/workspaces/{wid}/sessions/{sid}")
    emit(handle_response(r))


@app.command("update")
def update_cmd(
    workspace_id: str = typer.Argument(...),
    session_id: str = typer.Argument(...),
    profile: str | None = typer.Option(
        None, "--profile", "-p", help="Replace the live session's profile."
    ),
    default_profile: bool = typer.Option(
        False, "--default-profile", help="Use the workspace default profile."
    ),
) -> None:
    if (profile is None) == (not default_profile):
        raise typer.BadParameter("choose --profile or --default-profile")
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        wid = quote(workspace_id, safe="")
        sid = quote(session_id, safe="")
        r = client.request(
            "PATCH",
            f"/v1/workspaces/{wid}/sessions/{sid}",
            json={"profile": profile},
        )
    emit(handle_response(r))
