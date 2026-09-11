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
from mirage.config import _absolutize_scripts, _interpolate_env, load_config

app = typer.Typer(no_args_is_help=True, help="Manage workspaces.")


def _load_yaml(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _resolve_config(path: Path) -> dict[str, Any]:
    """Load + validate + interpolate env vars from the CLI's environment.

    Env interpolation runs client-side so the user's shell env (where
    they sourced ``.env.development`` etc.) is the source of truth.
    Missing vars fail fast here rather than producing a confusing
    error after a network round-trip.

    Validated here, but sent in the document's own spelling, the way
    the TypeScript CLI sends it: the daemon runs the same check, and
    the compiled dump does not re-validate (a CommandRule dumps its
    compiler-set ``mount`` field, which the document grammar refuses
    as never typed).
    """
    try:
        load_config(path)
    except ValueError as e:
        fail(str(e), exit_code=2)
    return _resolve_config_arg(path)


def _resolve_config_arg(path: Path) -> dict[str, Any]:
    """Read a workspace YAML/JSON config and interpolate ``${VAR}`` from
    the CLI's env, then rebase its relative script paths and code refs
    onto the file's directory, exactly as ``create`` does: a
    ``resource: ./wiki.py:WikiResource`` in a ``load``/``clone`` override
    means "next to this file", never "wherever the daemon runs". Skips
    validation because load/clone may only need a subset of mounts.
    Mirrors ``loadConfigArgument`` in the TypeScript CLI.
    """
    raw = _load_yaml(path)
    try:
        resolved = _interpolate_env(raw, dict(os.environ))
    except ValueError as e:
        fail(str(e), exit_code=2)
    _absolutize_scripts(resolved, path.resolve().parent)
    return resolved


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
            value = internals[key]
            shown = "n/a (not tracked)" if value is None else value
            lines.append(f"  {key:<16} {shown}")
    return "\n".join(lines)


def _format_asks(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No asks."
    rows = [[
        item["id"],
        item["session_id"],
        " ".join([item["command"], *item["argv"]]),
        item["outcome"] or "pending",
        item["reason"],
    ] for item in items]
    return format_table(["ID", "SESSION", "COMMAND", "STATUS", "REASON"], rows)


def _format_version_log(versions: list[dict[str, Any]]) -> str:
    if not versions:
        return "No versions."
    rows = [[v["id"][:12], v["message"]] for v in versions]
    return format_table(["VERSION", "MESSAGE"], rows)


def _format_diff(changes: dict[str, list[str]]) -> str:
    lines: list[str] = []
    for kind in ("added", "modified", "deleted"):
        for path in changes.get(kind, []):
            lines.append(f"{kind:<9} {path}")
    return "\n".join(lines) if lines else "No changes."


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
    body: dict[str, Any] = {"config": _resolve_config(config_path)}
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
    source_id: str = typer.Argument(..., help="Source workspace id."),
    new_id: str
    | None = typer.Option(None, "--id", help="Explicit id for the clone."),
    at: str | None = typer.Option(
        None,
        "--at",
        help="Clone from a past version (id or branch) not the live state."),
) -> None:
    """Clone a workspace, optionally from one of its past versions."""
    body: dict[str, Any] = {"source_id": source_id}
    if new_id:
        body["id"] = new_id
    if at:
        body["at"] = at
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST", "/v1/workspaces/clone", json=body)
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
    body: dict[str, Any] = {"path": str(tar_path.expanduser().resolve())}
    if new_id:
        body["id"] = new_id
    if config_path:
        body["override"] = _resolve_config_arg(config_path)
    with make_client() as client:
        client.ensure_running()
        r = client.request("POST", "/v1/workspaces/load", json=body)
    emit(handle_response(r), human=_format_workspace_detail)


@app.command("commit")
def commit_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    message: str = typer.Option("", "-m", "--message",
                                help="Version message."),
    branch: str = typer.Option("main",
                               "-b",
                               "--branch",
                               help="Branch to commit on."),
) -> None:
    """Commit the workspace's current state as a version."""
    body = {"message": message, "branch": branch}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/commit",
                           json=body)
    emit(handle_response(r),
         human=lambda d: f"Committed {d['version'][:12]} on {d['branch']}.")


@app.command("branch")
def branch_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    name: str = typer.Argument(..., help="New branch name."),
    from_branch: str = typer.Option("main",
                                    "--from",
                                    help="Branch to fork from."),
) -> None:
    """Create a branch at another branch's current version."""
    body = {"name": name, "from_branch": from_branch}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/branch",
                           json=body)
    emit(handle_response(r),
         human=lambda d:
         f"Created branch {d['branch']} at {d['version'][:12]}.")


@app.command("log")
def log_cmd(
        workspace_id: str = typer.Argument(..., help="Workspace id."),
        branch: str = typer.Option("main", "-b", "--branch"),
) -> None:
    """List a workspace's versions (newest first)."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "GET", f"/v1/workspaces/{workspace_id}/versions?branch={branch}")
    emit(handle_response(r), human=_format_version_log)


@app.command("diff")
def diff_cmd(
        workspace_id: str = typer.Argument(..., help="Workspace id."),
        a: str | None = typer.Argument(
            None, help="Base ref; omit to use live state."),
        b: str | None = typer.Argument(
            None, help="Compare ref; omit to use live state."),
        branch: str = typer.Option("main", "-b", "--branch"),
) -> None:
    """Show changed files (git-style).

    diff <id>          live vs HEAD
    diff <id> <a>      live vs <a>
    diff <id> <a> <b>  <a> vs <b>
    """
    params: dict[str, str] = {"branch": branch}
    if a is not None:
        params["a"] = a
    if b is not None:
        params["b"] = b
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("GET",
                           f"/v1/workspaces/{workspace_id}/diff",
                           params=params)
    emit(handle_response(r), human=_format_diff)


@app.command("list-asks")
def list_asks_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    session: str = typer.Option("",
                                "--session",
                                help="Only this session's asks."),
    all_records: bool = typer.Option(
        False,
        "--all",
        help="Include settled decisions, not just pending asks."),
) -> None:
    """List pending asks (every decision with --all)."""
    params: dict[str, str] = {}
    if session:
        params["session_id"] = session
    if all_records:
        params["all"] = "true"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("GET",
                           f"/v1/workspaces/{workspace_id}/asks",
                           params=params)
    emit(handle_response(r), human=_format_asks)


@app.command("allow")
def allow_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    ask_id: str = typer.Argument(...,
                                 help="Ask id, as quoted in the refusal."),
    scope: str = typer.Option(
        "once",
        "--scope",
        help="once answers the exact line; session answers every line "
        "the rule covers."),
    note: str = typer.Option("",
                             "--note",
                             help="What to record alongside the answer."),
) -> None:
    """Allow a pending ask; the retry of the asked line passes."""
    body = {"answer": "allow", "scope": scope, "note": note}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/asks/{ask_id}",
                           json=body)
    emit(handle_response(r),
         human=lambda d: f"Allowed {d['id']} ({d['scope']}).")


@app.command("deny")
def deny_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    ask_id: str = typer.Argument(...,
                                 help="Ask id, as quoted in the refusal."),
    note: str = typer.Option("",
                             "--note",
                             help="What to record alongside the answer."),
) -> None:
    """Deny a pending ask; the retry is refused in the deny voice, once."""
    body = {"answer": "deny", "note": note}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/asks/{ask_id}",
                           json=body)
    emit(handle_response(r), human=lambda d: f"Denied {d['id']}.")


@app.command("checkout")
def checkout_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    ref: str = typer.Argument(..., help="Version id or branch to restore."),
) -> None:
    """Restore a workspace in place to one of its versions."""
    body = {"ref": ref}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/checkout",
                           json=body)
    emit(handle_response(r), human=_format_workspace_detail)
