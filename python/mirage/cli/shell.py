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
import signal
import sys
from types import FrameType
from typing import IO, Any
from urllib.parse import quote

import typer

from mirage.cli.client import DaemonClient, make_client
from mirage.cli.output import (
    emit,
    exit_code_from_response,
    fail,
    handle_response,
)
from mirage.execution.types import ExecutionStatus as JobStatus

WAIT_SLICE_S = 30.0
INTERRUPTED = 130

app = typer.Typer(
    invoke_without_command=True, help="Run a shell line in a workspace."
)


@app.callback(invoke_without_command=True)
def shell_cmd(
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    command: str = typer.Option(
        ..., "--command", "-c", help="Shell line to run."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
    cwd: str | None = typer.Option(
        None,
        "--cwd",
        help="Working directory for this line (a workspace path).",
    ),
    runtime: str | None = typer.Option(
        None,
        "--runtime",
        help="Workspace runtime entry to place this line's captured "
        "stages on.",
    ),
    background: bool = typer.Option(
        False,
        "--background",
        "--bg",
        help="Don't wait; return job_id immediately.",
    ),
    explain: bool = typer.Option(
        False,
        "--explain",
        help="Say what the line would do, as a tree; run nothing.",
    ),
) -> None:
    """Run a shell line in a workspace.

    The line is a daemon job. With piped stdin it is one request that
    streams the input to the line as it reads it, so the line starts
    before the input ends; Ctrl-C drops the request, which cancels the
    job, and exits 130. Without piped stdin it is submitted, then
    waited on, and Ctrl-C, from the submit on, cancels it through
    ``DELETE /v1/jobs/{id}``. ``--background`` returns the job id at
    once instead, after any piped stdin has been sent. ``--explain``
    prints what the line would do instead, running none of it.
    """
    query: dict[str, str] = {"session_id": session_id} if session_id else {}
    payload: dict[str, Any] = {"command": command}
    if explain:
        with make_client() as client:
            client.ensure_running(allow_spawn=False)
            r = client.request(
                "POST",
                f"/v1/workspaces/{quote(workspace_id, safe='')}/shell",
                params={**query, "explain": "true"},
                json=payload,
            )
        emit(handle_response(r), human=_format_explanation)
        return
    if cwd:
        payload["cwd"] = cwd
    if runtime:
        payload["runtime"] = runtime
    path = f"/v1/workspaces/{quote(workspace_id, safe='')}/shell"
    piped = not sys.stdin.isatty()
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        if piped and not background:
            try:
                r = client.request(
                    "POST",
                    path,
                    params=query,
                    files=_upload(payload),
                    timeout=None,
                )
            except KeyboardInterrupt:
                raise typer.Exit(code=INTERRUPTED) from None
            if r.status_code == 499:
                fail("job canceled", exit_code=INTERRUPTED)
            result = handle_response(r)
            emit(result)
            raise typer.Exit(code=exit_code_from_response(result))
        interrupted = False

        def interrupt(signum: int, frame: FrameType | None) -> None:
            nonlocal interrupted
            interrupted = True

        held = None if background else signal.signal(signal.SIGINT, interrupt)
        try:
            if piped:
                r = client.request(
                    "POST",
                    path,
                    params={**query, "background": "true"},
                    files=_upload(payload),
                )
            else:
                r = client.request(
                    "POST",
                    path,
                    params={**query, "background": "true"},
                    json=payload,
                )
        finally:
            if held is not None:
                signal.signal(signal.SIGINT, held)
        submitted = handle_response(r)
        if not isinstance(submitted, dict):
            fail(f"unexpected daemon response: {submitted!r}")
        if background:
            emit(submitted)
            return
        job_id = quote(str(submitted["job_id"]), safe="")
        if not interrupted:
            try:
                job = wait_job(client, job_id)
            except KeyboardInterrupt:
                interrupted = True
        if interrupted:
            client.request("DELETE", f"/v1/jobs/{job_id}")
            wait_job(client, job_id)
            raise typer.Exit(code=INTERRUPTED)
    if job["status"] == JobStatus.FAILED:
        fail(f"shell failed: {job['error']}", exit_code=2)
    if job["status"] == JobStatus.CANCELED:
        fail("job canceled", exit_code=INTERRUPTED)
    emit(job["result"])
    raise typer.Exit(code=exit_code_from_response(job["result"]))


class _Pipe:
    """Piped stdin with no size to report.

    httpx sizes a file part with ``fstat``, which on a pipe counts only
    the bytes it holds right now; with no size it sends the part chunked.

    Args:
        stream (IO[bytes]): the stdin stream.
    """

    def __init__(self, stream: IO[bytes]) -> None:
        self._stream = stream

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)


def _upload(
    payload: dict[str, Any],
) -> dict[str, tuple[str, str | _Pipe, str]]:
    return {
        "request": ("request.json", json.dumps(payload), "application/json"),
        "stdin": (
            "stdin.bin",
            _Pipe(sys.stdin.buffer),
            "application/octet-stream",
        ),
    }


def _format_explanation(data: dict[str, Any]) -> str:
    """An explained line as a tree, one node a row, each command with
    its verdict.

    Args:
        data (dict[str, Any]): the ``explain/shell`` answer.
    """
    verdict = f"{data['outcome']}, exit {data['exit_code']}"
    if data["reason"]:
        verdict += f": {data['reason']}"
    out = [f"{data['line']}  [{verdict}]"]
    for child in data["node"]["children"]:
        _explained_lines(child, 1, out)
    return "\n".join(out)


def _explained_lines(node: dict[str, Any], depth: int, out: list[str]) -> None:
    """Append one node of an explained line, and what it holds, as rows.

    Args:
        node (dict[str, Any]): the node.
        depth (int): how deep it sits under the line.
        out (list[str]): the rows so far.
    """
    pad = "  " * depth
    if "outcome" not in node:
        out.append(f"{pad}{node['type']}: {node['text']}")
    else:
        line = f"{pad}{node['text']}  [{node['outcome']}"
        if node["exit_code"]:
            line += f", exit {node['exit_code']}"
        line += f": {node['reason']}]" if node["reason"] else "]"
        if node["source"]:
            line += f"  {node['source']}"
        if node["runtime"]:
            line += f"  on {node['runtime']}"
        out.append(line)
    for child in node["children"]:
        _explained_lines(child, depth + 1, out)


def wait_job(client: DaemonClient, job_id: str) -> dict[str, Any]:
    """Wait until a daemon job settles.

    Args:
        client (DaemonClient): the daemon client.
        job_id (str): the job, already quoted for a path.

    Returns:
        dict[str, Any]: the settled job.
    """
    while True:
        job = handle_response(
            client.request(
                "POST",
                f"/v1/jobs/{job_id}/wait",
                json={"timeout_s": WAIT_SLICE_S},
            )
        )
        if not isinstance(job, dict):
            fail(f"unexpected daemon response: {job!r}")
        if job["finished_at"] is not None:
            return job
