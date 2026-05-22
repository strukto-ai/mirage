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

import os
from pathlib import Path
from typing import Any

import typer
import yaml

from mirage.cli.client import make_client
from mirage.cli.output import (emit, fail, format_age, format_table,
                               handle_response)
from mirage.config import _interpolate_env, load_config

app = typer.Typer(no_args_is_help=True, help="Manage workspaces.")


def _load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _resolve_config(path: Path) -> dict:
    """Load + validate + interpolate env vars from the CLI's environment.

    Env interpolation runs client-side so the user's shell env (where
    they sourced ``.env.development`` etc.) is the source of truth.
    Missing vars fail fast here rather than producing a confusing
    error after a network round-trip.
    """
    try:
        cfg = load_config(path)
    except ValueError as e:
        fail(str(e), exit_code=2)
    return cfg.model_dump()


def _resolve_config_arg(path: Path) -> dict:
    """Read a workspace YAML/JSON config and interpolate ``${VAR}`` from
    the CLI's env. Skips validation because load/clone may only need a
    subset of mounts.
    """
    raw = _load_yaml(path)
    try:
        return _interpolate_env(raw, dict(os.environ))
    except ValueError as e:
        fail(str(e), exit_code=2)


def _format_workspace_list(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No active workspaces."
    rows = [[
        item["id"],
        item["mode"],
        str(item["mount_count"]),
        str(item["session_count"]),
        format_age(item["created_at"]),
    ] for item in items]
    return format_table(["ID", "MODE", "MOUNTS", "SESSIONS", "AGE"], rows)


def _format_workspace_detail(detail: dict[str, Any]) -> str:
    lines = [
        f"ID:        {detail['id']}",
        f"Mode:      {detail['mode']}",
        f"Created:   {format_age(detail['created_at'])} ago",
    ]
    mounts = detail.get("mounts") or []
    if mounts:
        rows = [[m["prefix"], m["resource"], m["mode"]] for m in mounts]
        lines.append("")
        lines.append("Mounts:")
        table = format_table(["PREFIX", "RESOURCE", "MODE"], rows)
        lines.extend("  " + ln for ln in table.splitlines())
    sessions = detail.get("sessions") or []
    if sessions:
        rows = [[s["session_id"], s["cwd"]] for s in sessions]
        lines.append("")
        lines.append("Sessions:")
        table = format_table(["SESSION", "CWD"], rows)
        lines.extend("  " + ln for ln in table.splitlines())
    internals = detail.get("internals")
    if internals:
        lines.append("")
        lines.append("Internals:")
        for key in ("cache_bytes", "cache_entries", "history_length",
                    "in_flight_jobs"):
            lines.append(f"  {key:<16} {internals[key]}")
    return "\n".join(lines)


@app.command("create")
def create_cmd(
    config_path: Path = typer.Argument(...,
                                       exists=True,
                                       readable=True,
                                       help="YAML/JSON workspace config."),
    workspace_id: str
    | None = typer.Option(None, "--id", help="Explicit workspace id."),
) -> None:
    """Create a workspace; daemon auto-spawns if not running."""
    body: dict = {"config": _resolve_config(config_path)}
    if workspace_id:
        body["id"] = workspace_id
    with make_client() as client:
        client.ensure_running()
        r = client.request("POST", "/v1/workspaces", json=body)
    emit(handle_response(r), human=_format_workspace_detail)


@app.command("list")
def list_cmd() -> None:
    """List active workspaces."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("GET", "/v1/workspaces")
    emit(handle_response(r), human=_format_workspace_list)


@app.command("get")
def get_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    verbose: bool = typer.Option(
        False,
        "--verbose",
        help="Include cache / dirty / history internals.",
    ),
) -> None:
    """Show full details for one workspace."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        path = f"/v1/workspaces/{workspace_id}"
        if verbose:
            path += "?verbose=true"
        r = client.request("GET", path)
    emit(handle_response(r), human=_format_workspace_detail)


@app.command("delete")
def delete_cmd(workspace_id: str = typer.Argument(...)) -> None:
    """Stop and remove a workspace."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("DELETE", f"/v1/workspaces/{workspace_id}")
    emit(handle_response(r), human=lambda d: f"Deleted workspace {d['id']}.")


@app.command("clone")
def clone_cmd(
    workspace_id: str = typer.Argument(..., help="Source workspace id."),
    new_id: str
    | None = typer.Option(None, "--id", help="Explicit id for the clone."),
) -> None:
    """Clone a workspace; defaults to fresh local backings + shared remotes."""
    body: dict = {}
    if new_id:
        body["id"] = new_id
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/clone",
                           json=body)
    emit(handle_response(r), human=_format_workspace_detail)


@app.command("snapshot")
def snapshot_cmd(
    workspace_id: str = typer.Argument(...),
    output: Path = typer.Argument(..., help="Path to write the .tar to."),
) -> None:
    """Snapshot a workspace to a tar file.

    The path is resolved to an absolute path and sent to the daemon,
    which writes the tar itself. With the default local daemon that is
    your filesystem; against a remote daemon the tar lands on the
    daemon host.
    """
    body = {"path": str(output.expanduser().resolve())}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/snapshot",
                           json=body)
    emit(
        handle_response(r),
        human=lambda d:
        f"Snapshot {d['id']} -> {d['path']} ({d['size']:,} bytes).",
    )


@app.command("load")
def load_cmd(
    tar_path: Path = typer.Argument(..., exists=True, readable=True),
    config_path: Path | None = typer.Argument(
        None,
        exists=True,
        readable=True,
        help="Optional workspace YAML/JSON config.",
    ),
    new_id: str | None = typer.Option(
        None, "--id", help="Explicit id for the restored workspace."),
) -> None:
    """Load a workspace from a tar file.

    The path is resolved to an absolute path and sent to the daemon,
    which reads the tar itself.
    """
    body: dict = {"path": str(tar_path.expanduser().resolve())}
    if new_id:
        body["id"] = new_id
    if config_path:
        body["override"] = _resolve_config_arg(config_path)
    with make_client() as client:
        client.ensure_running()
        r = client.request("POST", "/v1/workspaces/load", json=body)
    emit(handle_response(r), human=_format_workspace_detail)
