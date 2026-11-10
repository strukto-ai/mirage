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
from typing import Any
from urllib.parse import quote

import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, handle_response
from mirage.cli.settings import resolve_workspace
from mirage.cli.vfs import WORKSPACE
from mirage.cli.workspace import load_profile_argument

app = typer.Typer(no_args_is_help=True, help="Manage workspace sessions.")

SESSION = typer.Option(..., "--session", "-s", help="Session id.")
PROFILE = typer.Option(
    None, "--profile", "-p", help="Replace the live session's profile."
)
PROFILE_FILE = typer.Option(
    None,
    "--profile-file",
    exists=True,
    readable=True,
    help="Replace it with this YAML/JSON profile document.",
)
DEFAULT_PROFILE = typer.Option(
    False, "--default-profile", help="Use the workspace default profile."
)
MOUNT = typer.Option(
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
)
CREATE_PROFILE = typer.Option(
    None,
    "--profile",
    "-p",
    help=(
        "The profile this session runs under, by name from the "
        "workspace's profiles. A profile is the whole permission "
        "document; omit it to take the workspace default."
    ),
)


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


def _session_path(workspace_id: str, session_id: str | None = None) -> str:
    base = f"/v1/workspaces/{quote(workspace_id, safe='')}/sessions"
    return (
        base if session_id is None else f"{base}/{quote(session_id, safe='')}"
    )


@app.command("create")
def create_cmd(
    workspace_id: str | None = WORKSPACE,
    session_id: str | None = typer.Option(
        None,
        "--session",
        "-s",
        help="Explicit session id.",
    ),
    mount: list[str] = MOUNT,
    profile: str | None = CREATE_PROFILE,
) -> None:
    """Add a session to the workspace."""
    body: dict[str, Any] = {}
    if session_id:
        body["session_id"] = session_id
    if mount:
        body["mounts"] = _parse_mount_modes(mount)
    if profile:
        body["profile"] = profile
    path = _session_path(resolve_workspace(workspace_id))
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST", path, json=body)
    emit(handle_response(r))


@app.command("list")
def list_cmd(workspace_id: str | None = WORKSPACE) -> None:
    """List the workspace's sessions."""
    path = _session_path(resolve_workspace(workspace_id))
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("GET", path)
    emit(handle_response(r))


@app.command("delete")
def delete_cmd(
    workspace_id: str | None = WORKSPACE, session_id: str = SESSION
) -> None:
    """Close a session."""
    path = _session_path(resolve_workspace(workspace_id), session_id)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("DELETE", path)
    emit(handle_response(r))


@app.command("cancel")
def cancel_cmd(
    workspace_id: str | None = WORKSPACE, session_id: str = SESSION
) -> None:
    """Cancel the session's running and queued commands."""
    path = _session_path(resolve_workspace(workspace_id), session_id)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST", f"{path}/cancel")
    emit(handle_response(r))


@app.command("kill")
def kill_cmd(
    workspace_id: str | None = WORKSPACE, session_id: str = SESSION
) -> None:
    """Kill the session's background jobs; the session stays open."""
    path = _session_path(resolve_workspace(workspace_id), session_id)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST", f"{path}/kill")
    emit(handle_response(r))


@app.command("update")
def update_cmd(
    workspace_id: str | None = WORKSPACE,
    session_id: str = SESSION,
    profile: str | None = PROFILE,
    profile_file: Path | None = PROFILE_FILE,
    default_profile: bool = DEFAULT_PROFILE,
) -> None:
    """Replace the session's profile; its cwd, env and history stay."""
    if (
        sum((profile is not None, profile_file is not None, default_profile))
        != 1
    ):
        raise typer.BadParameter(
            "choose --profile, --profile-file or --default-profile"
        )
    body = {
        "profile": (
            load_profile_argument(profile_file)
            if profile_file is not None
            else profile
        )
    }
    path = _session_path(resolve_workspace(workspace_id), session_id)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("PATCH", path, json=body)
    emit(handle_response(r))
