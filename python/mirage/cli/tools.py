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

import sys
from typing import Any
from urllib.parse import quote

import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, handle_response

app = typer.Typer(
    help="The session's agent tools, as MCP serves them.", no_args_is_help=True
)


def call_tool(
    workspace_id: str,
    session_id: str | None,
    name: str,
    arguments: dict[str, Any],
) -> None:
    """Run one tool through the daemon's route and print its answer.

    Prints the response as JSON, or the tool's text on a terminal, and
    exits 1 when the tool failed.

    Args:
        workspace_id (str): the workspace.
        session_id (str | None): the session; None is the default.
        name (str): the tool.
        arguments (dict[str, Any]): the tool's input.
    """
    path = f"/v1/workspaces/{quote(workspace_id, safe='')}/tools/{name}"
    params = {"session_id": session_id} if session_id else None
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        response = client.request("POST", path, json=arguments, params=params)
    result = handle_response(response)
    emit(result, human=lambda r: r["text"])
    if isinstance(result, dict) and result.get("is_error"):
        raise typer.Exit(code=1)


def read_cmd(
    path: str = typer.Argument(..., help="File to read."),
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
    offset: int | None = typer.Option(
        None, "--offset", help="Line to start at (0-based)."
    ),
    limit: int | None = typer.Option(
        None, "--limit", help="Most lines to return."
    ),
) -> None:
    """Read a file with line numbers."""
    arguments: dict[str, Any] = {"path": path}
    if offset is not None:
        arguments["offset"] = offset
    if limit is not None:
        arguments["limit"] = limit
    call_tool(workspace_id, session_id, "read", arguments)


def write_cmd(
    path: str = typer.Argument(..., help="File to write."),
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
    content: str | None = typer.Option(
        None, "--content", help="Text to write; stdin when absent."
    ),
) -> None:
    """Write a file; an existing one must be read in full first."""
    text = content if content is not None else sys.stdin.read()
    call_tool(
        workspace_id, session_id, "write", {"path": path, "content": text}
    )


def edit_cmd(
    path: str = typer.Argument(..., help="File to edit."),
    old_string: str = typer.Argument(..., help="The exact text to replace."),
    new_string: str = typer.Argument(
        ..., help="The text to put in its place."
    ),
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
    replace_all: bool = typer.Option(
        False, "--replace-all", help="Replace every occurrence."
    ),
) -> None:
    """Replace a string in an existing file."""
    call_tool(
        workspace_id,
        session_id,
        "edit",
        {
            "path": path,
            "old_string": old_string,
            "new_string": new_string,
            "replace_all": replace_all,
        },
    )


def ls_cmd(
    path: str = typer.Argument(..., help="Directory to list."),
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
) -> None:
    """List a directory."""
    call_tool(workspace_id, session_id, "ls", {"path": path})


def grep_cmd(
    pattern: str = typer.Argument(
        ..., help="Regular expression to search for."
    ),
    path: str = typer.Argument(..., help="File or directory to search under."),
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
    ignore_case: bool = typer.Option(
        False, "-i", "--ignore-case", help="Match case-insensitively."
    ),
    fixed_strings: bool = typer.Option(
        False,
        "-F",
        "--fixed-strings",
        help="Read the pattern as a literal string.",
    ),
    include: str | None = typer.Option(
        None,
        "--include",
        help="Search only files whose name matches the glob.",
    ),
    context: int | None = typer.Option(
        None, "-C", "--context", help="Lines of context around each match."
    ),
    files_with_matches: bool = typer.Option(
        False,
        "-l",
        "--files-with-matches",
        help="Print only the names of matching files.",
    ),
    count: bool = typer.Option(
        False,
        "-c",
        "--count",
        help="Print only a count of matching lines per file.",
    ),
    max_count: int | None = typer.Option(
        None,
        "-m",
        "--max-count",
        help="Stop each file after this many matches.",
    ),
) -> None:
    """Search files recursively, as grep -rn does."""
    arguments: dict[str, Any] = {"pattern": pattern, "path": path}
    if ignore_case:
        arguments["ignore_case"] = True
    if fixed_strings:
        arguments["fixed_strings"] = True
    if include is not None:
        arguments["include"] = include
    if context is not None:
        arguments["context"] = context
    if files_with_matches:
        arguments["files_with_matches"] = True
    if count:
        arguments["count"] = True
    if max_count is not None:
        arguments["max_count"] = max_count
    call_tool(workspace_id, session_id, "grep", arguments)


def glob_cmd(
    pattern: str = typer.Argument(
        ..., help="Pathname pattern such as **/*.py."
    ),
    path: str = typer.Argument(
        "/", help="Directory a relative pattern is matched under."
    ),
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
) -> None:
    """Find files whose path matches a pattern."""
    call_tool(
        workspace_id, session_id, "glob", {"pattern": pattern, "path": path}
    )


def shell_cmd(
    command: str = typer.Argument(..., help="The command line to run."),
    workspace_id: str = typer.Option(
        ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
    ),
    session_id: str | None = typer.Option(
        None, "--session_id", "--session", "-s", help="Session id."
    ),
) -> None:
    """Run a command line and read its output as the agent does."""
    call_tool(workspace_id, session_id, "shell", {"command": command})


app.command("shell")(shell_cmd)
app.command("read")(read_cmd)
app.command("write")(write_cmd)
app.command("edit")(edit_cmd)
app.command("ls")(ls_cmd)
app.command("grep")(grep_cmd)
app.command("glob")(glob_cmd)
