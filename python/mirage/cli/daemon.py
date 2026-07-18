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
import signal
import time
from typing import Any

import httpx
import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, fail, format_age
from mirage.server.paths import pid_file_path

app = typer.Typer(no_args_is_help=True,
                  help="Manage the daemon process lifecycle.")


def _format_status(d: dict[str, Any]) -> str:
    if not d.get("running"):
        return f"Daemon not running. URL: {d['url']}"
    parts = [f"Running. PID {d.get('pid', '?')}"]
    uptime = d.get("uptime_s")
    if uptime is not None:
        parts.append(f"uptime {format_age(time.time() - uptime)}")
    ws_count = d.get("workspaces")
    if ws_count is not None:
        parts.append(f"{ws_count} workspace{'s' if ws_count != 1 else ''}")
    return ", ".join(parts) + f". URL: {d['url']}"


def _format_stop(d: dict[str, Any]) -> str:
    via = d.get("via", "?")
    pid = d.get("pid")
    return f"Stopped (via {via}{f', PID {pid}' if pid else ''})."


def _format_restart(d: dict[str, Any]) -> str:
    if d.get("spawned_fresh"):
        return "Restarted (eager spawn)."
    return "Restarted; next CLI command will auto-spawn."


def _format_kill(d: dict[str, Any]) -> str:
    if d.get("killed"):
        return f"Killed PID {d['pid']}."
    pid = d.get("pid")
    if pid is None:
        return "Daemon not running."
    return f"Already gone (PID {pid})."


def _read_pid() -> int | None:
    pid_file = pid_file_path()
    if not pid_file.exists():
        return None
    try:
        return int(pid_file.read_text().strip())
    except (ValueError, OSError):
        return None


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@app.command("status")
def status_cmd() -> None:
    """Show daemon health, PID, uptime, workspace count."""
    pid = _read_pid()
    with make_client() as client:
        url = client.settings.url
        try:
            r = client.request("GET", "/v1/health")
            health = r.json()
        except httpx.RequestError:
            health = None
    if health is None:
        emit({"running": False, "pid": pid, "url": url}, human=_format_status)
        raise typer.Exit(code=1)
    emit({
        "running": True,
        "pid": pid,
        "url": url,
        **health
    },
         human=_format_status)


@app.command("stop")
def stop_cmd(
    timeout: float = typer.Option(
        5.0,
        "--timeout",
        help="Seconds to wait for graceful exit before SIGTERM."),
) -> None:
    """Gracefully stop the daemon.

    Calls ``POST /v1/shutdown`` which trips the daemon's exit event.
    The daemon closes active workspaces and exits. If the daemon
    doesn't exit within ``--timeout``, fall back to SIGTERM via the
    PID file.
    """
    with make_client() as client:
        try:
            r = client.request("POST", "/v1/shutdown")
        except httpx.RequestError as e:
            fail(f"daemon not reachable: {e}", exit_code=1)
        if r.status_code >= 400:
            fail(f"shutdown failed: {r.text}", exit_code=2)

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with make_client() as client:
            if not client.is_reachable(timeout=0.3):
                emit({"stopped": True, "via": "graceful"}, human=_format_stop)
                return
        time.sleep(0.2)

    pid = _read_pid()
    if pid and _process_alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
            emit({
                "stopped": True,
                "via": "sigterm",
                "pid": pid
            },
                 human=_format_stop)
            return
        except ProcessLookupError:
            # the daemon exited between checks: that is the success condition
            pass
    fail(f"daemon did not exit within {timeout}s and no live PID found",
         exit_code=2)


@app.command("restart")
def restart_cmd(
    timeout: float = typer.Option(5.0, "--timeout"),
    eager: bool = typer.Option(
        False,
        "--eager",
        help="Spawn a fresh daemon immediately rather than waiting for "
        "the next CLI command to auto-spawn."),
) -> None:
    """Stop the daemon. Next CLI command auto-spawns a fresh one.

    Workspaces are LOST on restart. Save any you want to keep first
    with ``mirage workspace snapshot <id> <path>`` and bring them
    back with ``mirage workspace load <path>``.
    """
    with make_client() as client:
        try:
            client.request("POST", "/v1/shutdown")
        except httpx.RequestError:
            # daemon not listening: fall through to the signal-based stop
            pass
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with make_client() as client:
            if not client.is_reachable(timeout=0.3):
                break
        time.sleep(0.2)
    else:
        pid = _read_pid()
        if pid and _process_alive(pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                # the process exited on its own before the signal
                pass
    if eager:
        with make_client() as client:
            client.ensure_running()
        emit({"restarted": True, "spawned_fresh": True}, human=_format_restart)
        return
    emit(
        {
            "restarted": True,
            "spawned_fresh": False,
            "note": "next workspace --create will auto-spawn",
        },
        human=_format_restart,
    )


@app.command("kill")
def kill_cmd() -> None:
    """SIGKILL the daemon. Last resort -- skips graceful shutdown."""
    pid = _read_pid()
    if pid is None:
        emit({
            "killed": False,
            "reason": "no daemon running",
            "pid": None
        },
             human=_format_kill)
        return
    if not _process_alive(pid):
        emit({
            "killed": False,
            "reason": "process already gone",
            "pid": pid
        },
             human=_format_kill)
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        emit({
            "killed": False,
            "reason": "process gone",
            "pid": pid
        },
             human=_format_kill)
        return
    emit({"killed": True, "pid": pid}, human=_format_kill)
