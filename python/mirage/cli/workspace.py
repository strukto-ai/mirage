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

import asyncio
import os
import tempfile
from pathlib import Path
from typing import Any

import typer
import yaml

from mirage.cli.client import make_client
from mirage.cli.output import (emit, fail, format_age, format_table,
                               handle_response)
from mirage.cli.version.api import branch as version_branch
from mirage.cli.version.api import (commit_state, read_version, resolve_ref,
                                    status_state, version_diff, version_log)
from mirage.cli.version.state_tree import to_state
from mirage.cli.version.store import VersionStore
from mirage.config import _interpolate_env, load_config
from mirage.workspace.snapshot import read_tar, write_tar
from mirage.workspace.snapshot.manifest import split_manifest_and_blobs

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


def _resolve_override(path: Path) -> dict:
    """Read a partial-config YAML and interpolate ``${VAR}`` from the
    CLI's env. Skips validation -- overrides are intentionally partial.
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
    override: Path | None = typer.Option(
        None,
        "--override",
        exists=True,
        readable=True,
        help="Partial config YAML/JSON; merged into the clone's mounts.",
    ),
) -> None:
    """Clone a workspace; defaults to fresh local backings + shared remotes."""
    body: dict = {}
    if new_id:
        body["id"] = new_id
    if override:
        body["override"] = _resolve_override(override)
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
    new_id: str | None = typer.Option(
        None, "--id", help="Explicit id for the restored workspace."),
    override: Path | None = typer.Option(
        None,
        "--override",
        exists=True,
        readable=True,
        help="Partial config YAML/JSON for swapping creds.",
    ),
) -> None:
    """Load a workspace from a tar file.

    The path is resolved to an absolute path and sent to the daemon,
    which reads the tar itself.
    """
    body: dict = {"path": str(tar_path.expanduser().resolve())}
    if new_id:
        body["id"] = new_id
    if override:
        body["override"] = _resolve_override(override)
    with make_client() as client:
        client.ensure_running()
        r = client.request("POST", "/v1/workspaces/load", json=body)
    emit(handle_response(r), human=_format_workspace_detail)


def _resolve_store_path(store: Path | None) -> Path:
    if store is not None:
        return store
    cwd = Path.cwd()
    for parent in (cwd, *cwd.parents):
        candidate = parent / ".mirage"
        if (candidate / "objects").is_dir():
            return candidate
    return cwd / ".mirage"


def _format_version_log(versions: list[dict]) -> str:
    if not versions:
        return "No versions."
    rows = [[v["id"][:12], v["message"]] for v in versions]
    return format_table(["VERSION", "MESSAGE"], rows)


def _format_changes(changes: dict) -> str:
    lines = []
    for sign, kind in (("+", "added"), ("~", "modified"), ("-", "deleted")):
        for path in changes.get(kind, []):
            lines.append(f"{sign} {path}")
    return "\n".join(lines) if lines else "No changes."


def _daemon_snapshot(workspace_id: str, tar_path: Path) -> None:
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request("POST",
                           f"/v1/workspaces/{workspace_id}/snapshot",
                           json={"path": str(tar_path)})
    handle_response(r)


async def _do_commit(store_path: Path, tar_path: Path, branch: str,
                     message: str) -> str:
    state = read_tar(str(tar_path))
    store = await VersionStore.open(store_path)
    version = await commit_state(store, state, branch, message)
    return version.decode()


async def _do_log(store_path: Path, branch: str) -> list[dict]:
    store = await VersionStore.open(store_path)
    if branch not in await store.branches():
        return []
    return await version_log(store, branch)


async def _do_diff(store_path: Path, ref_a: str, ref_b: str) -> dict:
    store = await VersionStore.open(store_path)
    a = await resolve_ref(store, ref_a)
    b = await resolve_ref(store, ref_b)
    return await version_diff(store, a, b)


async def _do_branch(store_path: Path, name: str, from_branch: str) -> str:
    store = await VersionStore.open(store_path)
    await version_branch(store, name, from_branch)
    return (await store.head(name)).decode()


async def _do_status(store_path: Path, tar_path: Path, branch: str) -> dict:
    state = read_tar(str(tar_path))
    store = await VersionStore.open(store_path)
    return await status_state(store, state, branch)


async def _do_checkout_tar(store_path: Path, ref: str, tar_path: Path) -> None:
    store = await VersionStore.open(store_path)
    version = await resolve_ref(store, ref)
    entries, meta = await read_version(store, version)
    manifest, blobs = split_manifest_and_blobs(to_state(entries, meta))
    write_tar(str(tar_path), manifest, blobs)


@app.command("commit")
def commit_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id to snapshot."),
    message: str = typer.Option("", "-m", "--message",
                                help="Version message."),
    branch: str = typer.Option("main",
                               "-b",
                               "--branch",
                               help="Branch to commit on."),
    store: Path | None = typer.Option(
        None,
        "--store",
        help="Version store dir (default: walk up for .mirage)."),
) -> None:
    """Commit the live workspace as a version in the local .mirage store."""
    store_path = _resolve_store_path(store)
    with tempfile.TemporaryDirectory() as td:
        tar_path = Path(td) / "snapshot.tar"
        _daemon_snapshot(workspace_id, tar_path)
        version = asyncio.run(_do_commit(store_path, tar_path, branch,
                                         message))
    emit({
        "version": version,
        "branch": branch
    },
         human=lambda d: f"Committed {d['version'][:12]} on {d['branch']}.")


@app.command("log")
def log_cmd(
        branch: str = typer.Option("main", "-b", "--branch"),
        store: Path | None = typer.Option(None, "--store"),
) -> None:
    """List versions on a branch (newest first) from the local store."""
    versions = asyncio.run(_do_log(_resolve_store_path(store), branch))
    emit(versions, human=_format_version_log)


@app.command("diff")
def diff_cmd(
        ref_a: str = typer.Argument(..., help="Older version (branch or id)."),
        ref_b: str = typer.Argument(..., help="Newer version (branch or id)."),
        store: Path | None = typer.Option(None, "--store"),
) -> None:
    """Diff two versions; lists changed mount-relative paths."""
    changes = asyncio.run(_do_diff(_resolve_store_path(store), ref_a, ref_b))
    emit(changes, human=_format_changes)


@app.command("branch")
def branch_cmd(
        name: str = typer.Argument(..., help="New branch name."),
        from_branch: str = typer.Option("main",
                                        "--from",
                                        help="Branch to fork from."),
        store: Path | None = typer.Option(None, "--store"),
) -> None:
    """Create a branch at the head of another branch."""
    head = asyncio.run(
        _do_branch(_resolve_store_path(store), name, from_branch))
    emit({
        "branch": name,
        "head": head
    },
         human=lambda d: f"Branch {d['branch']} -> {d['head'][:12]}.")


@app.command("status")
def status_cmd(
        workspace_id: str = typer.Argument(...),
        branch: str = typer.Option("main", "-b", "--branch"),
        store: Path | None = typer.Option(None, "--store"),
) -> None:
    """Show uncommitted changes: live workspace vs branch head."""
    store_path = _resolve_store_path(store)
    with tempfile.TemporaryDirectory() as td:
        tar_path = Path(td) / "snapshot.tar"
        _daemon_snapshot(workspace_id, tar_path)
        changes = asyncio.run(_do_status(store_path, tar_path, branch))
    emit(changes, human=_format_changes)


@app.command("checkout")
def checkout_cmd(
        ref: str = typer.Argument(...,
                                  help="Version id or branch to restore."),
        new_id: str | None = typer.Option(
            None, "--id", help="Explicit id for the restored workspace."),
        store: Path | None = typer.Option(None, "--store"),
) -> None:
    """Restore a version into a new workspace via the daemon."""
    store_path = _resolve_store_path(store)
    with tempfile.TemporaryDirectory() as td:
        tar_path = Path(td) / "version.tar"
        asyncio.run(_do_checkout_tar(store_path, ref, tar_path))
        body: dict = {"path": str(tar_path)}
        if new_id:
            body["id"] = new_id
        with make_client() as client:
            client.ensure_running()
            r = client.request("POST", "/v1/workspaces/load", json=body)
        result = handle_response(r)
    emit(result, human=_format_workspace_detail)
