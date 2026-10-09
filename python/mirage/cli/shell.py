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
import sys
from typing import IO, Any
from urllib.parse import quote, urlencode

import typer

from mirage.cli.client import make_client
from mirage.cli.output import (
    emit,
    fail,
    handle_response,
)
from mirage.cli.vfs import answer, post

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
    json_output: bool = typer.Option(
        False,
        "--json",
        help="Collect output and print the final result as JSON.",
    ),
    explain: bool = typer.Option(
        False,
        "--explain",
        help="Say what the line would do, as a tree; run nothing.",
    ),
) -> None:
    """Run a shell line in a workspace.

    Foreground output streams to stdout and stderr as bytes. ``--json``
    collects those same streams into the final result. Piped input uploads
    concurrently in either mode. Ctrl-C cancels the request and exits 130.
    ``--background`` returns the job id after input uploads. ``--explain``
    describes the line without running it.
    """
    query: dict[str, str] = {"session_id": session_id} if session_id else {}
    payload: dict[str, Any] = {"command": command}
    if cwd:
        payload["cwd"] = cwd
    if runtime:
        payload["runtime"] = runtime
    if explain:
        said = answer(post(workspace_id, "shell", payload, session_id, True))
        emit(said, human=None if json_output else _format_explanation)
        return
    path = f"/v1/workspaces/{quote(workspace_id, safe='')}/shell"
    piped = not sys.stdin.isatty()
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        if not background:
            import asyncio

            from mirage.cli.stream import stream_shell

            try:
                with asyncio.Runner() as runner:
                    code = runner.run(
                        stream_shell(
                            client,
                            path
                            + "?"
                            + urlencode({**query, "stream": "true"}),
                            payload,
                            piped,
                            json_output=json_output,
                        )
                    )
            except KeyboardInterrupt:
                raise typer.Exit(code=130) from None
            except BrokenPipeError:
                raise typer.Exit(code=141) from None
            except (OSError, RuntimeError, ValueError) as exc:
                fail(str(exc), exit_code=2)
            raise typer.Exit(code=code)
        if piped:
            response = client.request(
                "POST",
                path,
                params={**query, "background": "true"},
                files=_upload(payload),
            )
        else:
            response = client.request(
                "POST",
                path,
                params={**query, "background": "true"},
                json=payload,
            )
        emit(handle_response(response))


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
