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
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

import typer

from mirage.cli.client import make_client
from mirage.cli.output import (
    emit,
    fail,
    format_age,
    format_table,
    handle_response,
)

app = typer.Typer(no_args_is_help=True, help="Manage workspaces.")


def resolve_config(path: Path) -> dict[str, Any]:
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
    from mirage.config import load_config

    try:
        load_config(path)
    except ValueError as e:
        fail(str(e), exit_code=2)
    return _resolve_config_arg(path)


def _resolve_config_arg(path: Path) -> dict[str, Any]:
    """Read a workspace YAML/JSON config and interpolate ``${VAR}`` from
    the CLI's env, then rebase its relative script paths and code refs
    onto the file's directory, exactly as ``create`` does: a
    ``vfs: ./wiki.py:WikiVFS`` in a ``load``/``clone`` override
    means "next to this file", never "wherever the daemon runs". Skips
    validation because load/clone may only need a subset of mounts.
    Mirrors ``loadConfigArgument`` in the TypeScript CLI, which defers
    the config module the same way so a spawn that loads no config
    never pays for it.
    """
    from mirage.config import _absolutize_scripts, _interpolate_env, _load_yaml

    raw = _load_yaml(path) or {}
    try:
        resolved = _interpolate_env(raw, dict(os.environ))
    except ValueError as e:
        fail(str(e), exit_code=2)
    _absolutize_scripts(resolved, path.resolve().parent)
    return resolved


def _format_workspace_list(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No active workspaces."
    rows = [
        [
            item["id"],
            item["mode"],
            str(item["mount_count"]),
            str(item["session_count"]),
            format_age(item["created_at"]),
        ]
        for item in items
    ]
    return format_table(["ID", "MODE", "MOUNTS", "SESSIONS", "AGE"], rows)


def _format_workspace_detail(detail: dict[str, Any]) -> str:
    lines = [
        f"ID:        {detail['id']}",
        f"Mode:      {detail['mode']}",
        f"Created:   {format_age(detail['created_at'])} ago",
    ]
    mounts = detail.get("mounts") or []
    if mounts:
        rows = [[m["prefix"], m["vfs"], m["mode"]] for m in mounts]
        lines.append("")
        lines.append("Mounts:")
        table = format_table(["PREFIX", "VFS", "MODE"], rows)
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
        for key in (
            "cache_bytes",
            "cache_entries",
            "history_length",
            "in_flight_jobs",
        ):
            value = internals[key]
            shown = "n/a (not tracked)" if value is None else value
            lines.append(f"  {key:<16} {shown}")
    return "\n".join(lines)


def _format_asks(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No asks."
    rows = [
        [
            item["id"],
            item["session_id"],
            " ".join([item["command"], *item["argv"]]),
            item["outcome"] or "pending",
            item["reason"],
        ]
        for item in items
    ]
    return format_table(["ID", "SESSION", "COMMAND", "STATUS", "REASON"], rows)


@app.command("create")
def create_cmd(
    config_path: Path = typer.Argument(
        ..., exists=True, readable=True, help="YAML/JSON workspace config."
    ),
    workspace_id: str | None = typer.Option(
        None, "--id", help="Explicit workspace id."
    ),
) -> None:
    """Create a workspace; daemon auto-spawns if not running."""
    body: dict[str, Any] = {"config": resolve_config(config_path)}
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
        path = f"/v1/workspaces/{quote(workspace_id, safe='')}"
        if verbose:
            path += "?verbose=true"
        r = client.request("GET", path)
    emit(handle_response(r), human=_format_workspace_detail)


@app.command("delete")
def delete_cmd(workspace_id: str = typer.Argument(...)) -> None:
    """Stop and remove a workspace."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "DELETE", f"/v1/workspaces/{quote(workspace_id, safe='')}"
        )
    emit(handle_response(r), human=lambda d: f"Deleted workspace {d['id']}.")


@app.command("close")
def close_cmd(workspace_id: str = typer.Argument(...)) -> None:
    """Stop a workspace and keep its state for the same id."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "POST", f"/v1/workspaces/{quote(workspace_id, safe='')}/close"
        )
    emit(handle_response(r), human=lambda d: f"Closed workspace {d['id']}.")


@app.command("cancel")
def cancel_cmd(workspace_id: str = typer.Argument(...)) -> None:
    """Cancel the running and queued commands of every session."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "POST", f"/v1/workspaces/{quote(workspace_id, safe='')}/cancel"
        )
    emit(handle_response(r))


@app.command("kill")
def kill_cmd(workspace_id: str = typer.Argument(...)) -> None:
    """Kill the background jobs of every session."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "POST", f"/v1/workspaces/{quote(workspace_id, safe='')}/kill"
        )
    emit(handle_response(r))


@app.command("clone")
def clone_cmd(
    source_id: str = typer.Argument(..., help="Source workspace id."),
    new_id: str | None = typer.Option(
        None, "--id", help="Explicit id for the clone."
    ),
) -> None:
    """Clone a workspace's live state."""
    body: dict[str, Any] = {}
    if new_id:
        body["id"] = new_id
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "POST",
            f"/v1/workspaces/{quote(source_id, safe='')}/clone",
            json=body,
        )
    emit(handle_response(r), human=_format_workspace_detail)


@app.command("snapshot")
def snapshot_cmd(
    workspace_id: str = typer.Argument(...),
    output: Path | None = typer.Argument(
        None, help="File to write the .tar to, on this machine."
    ),
    key: str | None = typer.Option(
        None, "--key", help="Put it in the server's snapshot store instead."
    ),
) -> None:
    """Snapshot a workspace.

    The server sends the tar back and it is written to OUTPUT here,
    whether the server runs on this machine or another. With --key it
    goes to the server's snapshot store under that key.
    """
    if (output is None) == (key is None):
        fail("snapshot takes an output file or --key", 2)
    path = f"/v1/workspaces/{quote(workspace_id, safe='')}/snapshot"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        if key is not None:
            r = client.request("POST", path, json={"key": key}, timeout=None)
            d = handle_response(r)
            target = key
        else:
            r = client.request("GET", path, timeout=None)
            if r.status_code >= 400:
                handle_response(r)
            assert output is not None
            target = str(output.expanduser())
            Path(target).write_bytes(r.content)
            d = {"id": workspace_id, "path": target, "size": len(r.content)}
    emit(
        d,
        human=lambda x: (
            f"Snapshot {x['id']} -> {target} ({x['size']:,} bytes)."
        ),
    )


@app.command("load")
def load_cmd(
    paths: list[Path] | None = typer.Argument(
        None,
        metavar="[FILE] [CONFIG]",
        help="The .tar to upload, then an optional workspace YAML/JSON "
        "config; with --key, only the config.",
    ),
    key: str | None = typer.Option(
        None, "--key", help="Load from the server's snapshot store."
    ),
    new_id: str | None = typer.Option(
        None, "--id", help="Explicit id for the restored workspace."
    ),
) -> None:
    """Load a workspace from a snapshot.

    FILE is read here and uploaded, whether the server runs on this
    machine or another. With --key the tar comes from the server's
    snapshot store.
    """
    given = list(paths or [])
    if key is not None and len(given) > 1:
        fail("load takes a FILE or --key, not both", 2)
    if key is None and not 1 <= len(given) <= 2:
        fail("load takes a FILE (or --key) and an optional CONFIG", 2)
    tar_path = None if key is not None else given.pop(0)
    config_path = given[0] if given else None
    for p in (tar_path, config_path):
        if p is not None and not p.expanduser().is_file():
            fail(f"file not found: {p}", 2)
    body: dict[str, Any] = {}
    if new_id:
        body["id"] = new_id
    if config_path:
        body["override"] = _resolve_config_arg(config_path)
    with make_client() as client:
        client.ensure_running()
        if tar_path is None:
            r = client.request(
                "POST",
                "/v1/workspaces/load",
                json={**body, "key": key},
                timeout=None,
            )
        else:
            with tar_path.expanduser().open("rb") as tar:
                r = client.request(
                    "POST",
                    "/v1/workspaces/load",
                    files={
                        "request": (
                            "request.json",
                            json.dumps(body),
                            "application/json",
                        ),
                        "snapshot": (
                            tar_path.name,
                            tar,
                            "application/x-tar",
                        ),
                    },
                    timeout=None,
                )
    emit(handle_response(r), human=_format_workspace_detail)


@app.command("list-asks")
def list_asks_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    session: str = typer.Option(
        "", "--session", help="Only this session's asks."
    ),
    all_records: bool = typer.Option(
        False,
        "--all",
        help="Include settled decisions, not just pending asks.",
    ),
) -> None:
    """List pending asks (every decision with --all)."""
    params: dict[str, str] = {}
    if session:
        params["session_id"] = session
    if all_records:
        params["all"] = "true"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "GET",
            f"/v1/workspaces/{quote(workspace_id, safe='')}/asks",
            params=params,
        )
    emit(handle_response(r), human=_format_asks)


@app.command("allow")
def allow_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    ask_id: str = typer.Argument(
        ..., help="Ask id, as quoted in the refusal."
    ),
    scope: str = typer.Option(
        "once",
        "--scope",
        help="once answers the exact line; session answers every line "
        "the rule covers.",
    ),
    note: str = typer.Option(
        "", "--note", help="What to record alongside the answer."
    ),
) -> None:
    """Allow a pending ask; the retry of the asked line passes."""
    body = {"answer": "allow", "scope": scope, "note": note}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        wid = quote(workspace_id, safe="")
        aid = quote(ask_id, safe="")
        r = client.request(
            "POST", f"/v1/workspaces/{wid}/asks/{aid}", json=body
        )
    emit(
        handle_response(r),
        human=lambda d: f"Allowed {d['id']} ({d['scope']}).",
    )


@app.command("deny")
def deny_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    ask_id: str = typer.Argument(
        ..., help="Ask id, as quoted in the refusal."
    ),
    note: str = typer.Option(
        "", "--note", help="What to record alongside the answer."
    ),
) -> None:
    """Deny a pending ask; the retry is refused in the deny voice, once."""
    body = {"answer": "deny", "note": note}
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        wid = quote(workspace_id, safe="")
        aid = quote(ask_id, safe="")
        r = client.request(
            "POST", f"/v1/workspaces/{wid}/asks/{aid}", json=body
        )
    emit(handle_response(r), human=lambda d: f"Denied {d['id']}.")


def _document_cmd(
    workspace_id: str,
    kind: str,
    path: str | None,
    session: str | None,
    profile: str | None,
) -> None:
    if profile is not None and (path is not None or session is not None):
        raise typer.BadParameter("--profile requires no --path or --session")
    route = f"/v1/workspaces/{quote(workspace_id, safe='')}"
    if session is not None:
        route += f"/sessions/{quote(session, safe='')}"
    route += f"/{kind}-md"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        if path is None:
            r = client.request(
                "GET",
                route,
                params={"profile": profile} if profile is not None else {},
            )
        else:
            r = client.request("PUT", route, json={"path": path})
    if r.is_error:
        handle_response(r)
    if path is None:
        typer.echo(r.text, nl=False)


@app.command("vfs-md")
def vfs_md_cmd(
    workspace_id: str = typer.Argument(...),
    path: str | None = typer.Option(
        None, help="Expose a live file at this workspace path."
    ),
    session: str | None = typer.Option(
        None, help="Limit exposure or generation to this session."
    ),
    profile: str | None = typer.Option(
        None, help="Preview this profile without creating a file."
    ),
) -> None:
    """Generate VFS Markdown, or expose it inside the workspace with --path."""
    _document_cmd(workspace_id, "vfs", path, session, profile)


@app.command("skill-md")
def skill_md_cmd(
    workspace_id: str = typer.Argument(...),
    path: str | None = typer.Option(
        None, help="Expose a live file at this workspace path."
    ),
    session: str | None = typer.Option(
        None, help="Limit exposure or generation to this session."
    ),
    profile: str | None = typer.Option(
        None, help="Preview this profile without creating a file."
    ),
) -> None:
    """Generate a CLI skill, or expose it inside the workspace with --path."""
    _document_cmd(workspace_id, "skill", path, session, profile)
