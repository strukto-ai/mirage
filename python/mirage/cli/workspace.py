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

import codecs
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote

import typer
import yaml

from mirage.cli.client import make_client
from mirage.cli.output import (
    emit,
    fail,
    format_age,
    format_table,
    handle_response,
)
from mirage.cli.policy import keep_policy_names
from mirage.cli.settings import header, use_workspace
from mirage.utils.yaml import parse_yaml

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
    return _load_config_argument(path)


def _load_config_argument(path: Path) -> dict[str, Any]:
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
    from mirage.config import (
        _absolutize_scripts,
        _interpolate_env,
    )

    raw = parse_yaml(path.read_text(encoding="utf-8")) or {}
    try:
        resolved = cast(
            dict[str, Any], _interpolate_env(raw, dict(os.environ))
        )
    except ValueError as e:
        fail(str(e), exit_code=2)
    keep_policy_names(
        resolved, lambda: _absolutize_scripts(resolved, path.resolve().parent)
    )
    return resolved


def load_profile_argument(path: Path) -> dict[str, Any]:
    """Read a profile YAML/JSON document the way a config file's
    ``profiles`` entry is read: ``${VAR}`` interpolated from the CLI's
    env, and a relative policy ``script`` rebased onto the file's
    directory. Mirrors ``loadProfileArgument`` in the TypeScript CLI.

    Args:
        path (Path): the profile document.
    """
    from mirage.config import (
        _absolutize_scripts,
        _interpolate_env,
    )

    try:
        doc = parse_yaml(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        fail(f"invalid profile YAML/JSON at {path}: {e}", exit_code=2)
    if not isinstance(doc, dict):
        fail(f"profile file must hold a mapping: {path}", exit_code=2)
    try:
        resolved = _interpolate_env({"profiles": {"": doc}}, dict(os.environ))
    except ValueError as e:
        fail(str(e), exit_code=2)
    _absolutize_scripts(resolved, path.resolve().parent)
    return cast(dict[str, Any], resolved["profiles"][""])


def _format_workspace_list(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No workspaces."
    rows = [[item["id"], item["status"]] for item in items]
    return format_table(["ID", "STATUS"], rows)


def _format_workspace_detail(detail: dict[str, Any]) -> str:
    lines = [
        f"ID:        {detail['id']}",
        f"Status:    {detail['status']}",
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


def _format_workspace_explanation(data: dict[str, Any]) -> str:
    """What the server's policies make of a config: the verdict, then
    each policy's answer.

    Args:
        data (dict[str, Any]): the explained create.
    """
    verdict = data["outcome"]
    if data["reason"]:
        verdict += f": {data['reason']}"
    out = [f"[{verdict}]"]
    out.extend(
        f"  {said['policy']}: {said['kind']}: {said['reason']}"
        for said in data["answers"]
    )
    return "\n".join(out)


def _format_logs(page: dict[str, Any]) -> str:
    if not page["items"]:
        return "No logs."
    rows = [
        [
            datetime.fromtimestamp(item["started_at"] / 1000, UTC).strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            str(item["exit_code"]) if item["exit_code"] is not None else "",
            item["command"].replace("\n", "\\n"),
        ]
        for item in page["items"]
    ]
    text = format_table(["TIME", "EXIT", "COMMAND"], rows)
    if page["next"] is not None:
        text += f"\nNext page: --after {page['next']}"
    return text


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


def _exit_cell(item: dict[str, Any]) -> str:
    return "-" if item["exit"] is None else str(item["exit"])


def _format_lines(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No lines."
    rows = [
        [
            item["id"],
            item["session_id"],
            item["state"],
            _exit_cell(item),
            item["command"],
        ]
        for item in items
    ]
    return format_table(["ID", "SESSION", "STATE", "EXIT", "COMMAND"], rows)


def _format_jobs(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No jobs."
    rows = [
        [
            item["id"],
            f"%{item['number']}",
            "-" if item["pid"] is None else str(item["pid"]),
            item["session_id"],
            item["state"],
            _exit_cell(item),
            item["command"],
        ]
        for item in items
    ]
    return format_table(
        ["ID", "JOB", "PID", "SESSION", "STATE", "EXIT", "COMMAND"], rows
    )


def _format_processes(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No processes."
    rows = [
        [
            str(item["pid"]),
            str(item["parent"] or 0),
            item["machine"],
            item["session_id"],
            item["state"],
            _exit_cell(item),
            item["command"],
        ]
        for item in items
    ]
    return format_table(
        ["PID", "PPID", "MACHINE", "SESSION", "STATE", "EXIT", "COMMAND"],
        rows,
    )


def _format_machines(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No machines."
    rows = [[item["id"], item["state"]] for item in items]
    return format_table(["MACHINE", "STATE"], rows)


def _list_records(
    workspace_id: str, kind: str, params: dict[str, str]
) -> dict[str, Any] | list[Any]:
    """One of the workspace's record lists, by its route.

    Args:
        workspace_id (str): the workspace.
        kind (str): ``lines``, ``jobs``, ``processes`` or ``machines``.
        params (dict[str, str]): the list's filters.
    """
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "GET",
            f"/v1/workspaces/{quote(workspace_id, safe='')}/{kind}",
            params={k: v for k, v in params.items() if v},
        )
    return handle_response(r)


@app.command("create")
def create_cmd(
    config_path: Path | None = typer.Argument(
        None, exists=True, readable=True, help="YAML/JSON workspace config."
    ),
    template: str | None = typer.Option(
        None, "--template", help="Create from this saved template."
    ),
    workspace_id: str | None = typer.Option(
        None, "--workspace", "-w", "--id", help="Explicit workspace id."
    ),
    explain: bool = typer.Option(
        False,
        "--explain",
        help="Say what the server's policies make of it; create nothing.",
    ),
) -> None:
    """Create a workspace from a config file or a saved template; daemon
    auto-spawns if not running.

    ``--explain`` asks the server's policies about the config without
    creating anything.
    """
    if (config_path is None) == (template is None):
        fail("give a config file or --template NAME, not both", 2)
    body: dict[str, Any] = (
        {"template": template}
        if config_path is None
        else {"config": resolve_config(config_path)}
    )
    if workspace_id:
        body["id"] = workspace_id
    with make_client() as client:
        client.ensure_running()
        r = client.request(
            "POST",
            "/v1/workspaces",
            json=body,
            params={"explain": "true"} if explain else None,
        )
    created = handle_response(r)
    if not explain and isinstance(created, dict):
        header(f"created {created.get('id')}")
    emit(
        created,
        human=_format_workspace_explanation
        if explain
        else _format_workspace_detail,
    )


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


@app.command("use")
def use_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
) -> None:
    """Make a workspace the current context's, for the commands that
    take ``-w``."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "GET", f"/v1/workspaces/{quote(workspace_id, safe='')}"
        )
        context = client.settings.context
    handle_response(r)
    use_workspace(context, workspace_id)
    header(f"using {workspace_id}", context)
    emit(
        {"workspace": workspace_id},
        human=lambda d: f"Using workspace {workspace_id}.",
    )


@app.command("delete")
def delete_cmd(workspace_id: str = typer.Argument(...)) -> None:
    """Stop and remove a workspace."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "DELETE", f"/v1/workspaces/{quote(workspace_id, safe='')}"
        )
    # The hosted API answers 204 with no body, so the id is the one given.
    deleted = cast(dict[str, Any], handle_response(r))
    header(f"deleted {workspace_id}")
    emit(
        {"id": workspace_id, **deleted},
        human=lambda _: f"Deleted workspace {workspace_id}.",
    )


@app.command("stop")
def stop_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
) -> None:
    """Stop a workspace and keep its state for ``start``."""
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r = client.request(
            "POST", f"/v1/workspaces/{quote(workspace_id, safe='')}/stop"
        )
    stopped = handle_response(r)
    header(f"stopped {workspace_id}")
    emit(stopped, human=lambda d: f"Stopped workspace {d['id']}.")


@app.command("start")
def start_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
) -> None:
    """Start a stopped workspace from the config it was created with.

    The daemon is started if it has exited, as it does once idle.
    """
    with make_client() as client:
        client.ensure_running()
        r = client.request(
            "POST", f"/v1/workspaces/{quote(workspace_id, safe='')}/start"
        )
    started = handle_response(r)
    header(f"started {workspace_id}")
    emit(started, human=lambda d: f"Started workspace {d['id']}.")


@app.command("set-profile")
def set_profile_cmd(
    workspace_id: str = typer.Argument(...),
    name: str = typer.Argument(..., help="The profile's name."),
    profile_path: Path = typer.Argument(
        ..., exists=True, readable=True, help="YAML/JSON profile document."
    ),
) -> None:
    """Define or replace a named profile on the live workspace.

    Sessions keep their rules until `session update` moves them, and the
    workspace config is not rewritten.
    """
    body = load_profile_argument(profile_path)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        wid = quote(workspace_id, safe="")
        r = client.request(
            "PUT",
            f"/v1/workspaces/{wid}/profiles/{quote(name, safe='')}",
            json=body,
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
        body["override"] = _load_config_argument(config_path)
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


@app.command("logs")
def logs_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    session: str = typer.Option(
        "", "--session", help="Only this session's commands."
    ),
    limit: int = typer.Option(
        50, "--limit", help="Commands per page (1-200)."
    ),
    after: str = typer.Option(
        "", "--after", help="Cursor from the previous page."
    ),
    jsonl: bool = typer.Option(
        False,
        "--jsonl",
        help="Export all matching retained commands, oldest first.",
    ),
) -> None:
    """Show completed commands, newest first."""
    params = {"limit": str(limit)}
    if session:
        params["session"] = session
    if after:
        params["after"] = after
    path = f"/v1/workspaces/{quote(workspace_id, safe='')}/logs"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        if jsonl:
            params["format"] = "jsonl"
            with client.stream("GET", path, params=params) as response:
                if response.status_code >= 400:
                    response.read()
                    handle_response(response)
                for text in codecs.iterdecode(response.iter_bytes(), "utf-8"):
                    typer.echo(text, nl=False)
            return
        response = client.request("GET", path, params=params)
    emit(handle_response(response), human=_format_logs)


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


@app.command("list-lines")
def list_lines_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    session: str = typer.Option(
        "", "--session", help="Only this session's lines."
    ),
    state: str = typer.Option(
        "", "--state", help="Only the lines in this state."
    ),
) -> None:
    """List the lines the workspace keeps: running and newest ended."""
    params = {"session_id": session, "state": state}
    emit(_list_records(workspace_id, "lines", params), human=_format_lines)


@app.command("list-jobs")
def list_jobs_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    session: str = typer.Option(
        "", "--session", help="Only this session's jobs."
    ),
    state: str = typer.Option(
        "", "--state", help="Only the jobs in this state."
    ),
    line: str = typer.Option(
        "", "--line", help="Only the jobs this line started."
    ),
) -> None:
    """List the workspace's jobs, as each session's jobs shows them."""
    params = {"session_id": session, "state": state, "line_id": line}
    emit(_list_records(workspace_id, "jobs", params), human=_format_jobs)


@app.command("list-processes")
def list_processes_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
    session: str = typer.Option(
        "", "--session", help="Only this session's processes."
    ),
    state: str = typer.Option(
        "", "--state", help="Only the processes in this state."
    ),
    line: str = typer.Option(
        "", "--line", help="Only the processes this line ran."
    ),
    job: str = typer.Option(
        "", "--job", help="Only the processes this job ran."
    ),
    machine: str = typer.Option(
        "",
        "--machine",
        help="Only the processes run on this machine (provider:name).",
    ),
) -> None:
    """List the processes the workspace keeps: live and newest ended."""
    params = {
        "session_id": session,
        "state": state,
        "line_id": line,
        "job_id": job,
        "machine": machine,
    }
    emit(
        _list_records(workspace_id, "processes", params),
        human=_format_processes,
    )


@app.command("list-machines")
def list_machines_cmd(
    workspace_id: str = typer.Argument(..., help="Workspace id."),
) -> None:
    """List the machines the workspace runs programs on, each checked now."""
    emit(_list_records(workspace_id, "machines", {}), human=_format_machines)


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
