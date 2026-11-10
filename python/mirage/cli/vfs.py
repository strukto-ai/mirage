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

import base64
import inspect
import sys
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx
import typer

from mirage.cli.client import make_client
from mirage.cli.output import emit, error_of, handle_response
from mirage.cli.settings import resolve_workspace
from mirage.server.vfs_calls import (
    BYTES,
    FLAG,
    INTEGER,
    OWNER,
    SIZE,
    VFS_CALLS,
    VfsCall,
)

app = typer.Typer(
    help="The session's VFS calls, one command per call, as POSIX names them.",
    no_args_is_help=True,
)

WORKSPACE = typer.Option(
    None,
    "--workspace",
    "-w",
    help="Workspace id; the current workspace when left out.",
)
SESSION = typer.Option(None, "--session", "-s", help="Session id.")
EXPLAIN = typer.Option(
    False, "--explain", help="Say what the call would do; run nothing."
)


def _route(
    workspace_id: str | None,
    route: str,
    session_id: str | None,
    explain: bool = False,
) -> tuple[str, dict[str, str]]:
    params: dict[str, str] = {}
    if session_id:
        params["session_id"] = session_id
    if explain:
        params["explain"] = "true"
    workspace_id = resolve_workspace(workspace_id)
    return f"/v1/workspaces/{quote(workspace_id, safe='')}/{route}", params


def post(
    workspace_id: str | None,
    route: str,
    body: dict[str, Any],
    session_id: str | None,
    explain: bool = False,
) -> httpx.Response:
    """Send one session call to the daemon.

    Args:
        workspace_id (str | None): the workspace; the current one when
            None.
        route (str): the call's route under the workspace.
        body (dict[str, Any]): its arguments.
        session_id (str | None): the session; None is the default.
        explain (bool): ask what the call would do instead.
    """
    path, params = _route(workspace_id, route, session_id, explain)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        return client.request("POST", path, json=body, params=params)


def _read_to_stdout(
    workspace_id: str | None, body: dict[str, Any], session_id: str | None
) -> None:
    """Write a read's bytes to stdout as they arrive, as they are, so a
    big or binary file passes through whole.

    Args:
        workspace_id (str | None): the workspace; the current one when
            None.
        body (dict[str, Any]): the read's arguments.
        session_id (str | None): the session; None is the default.
    """
    path, params = _route(workspace_id, "vfs/read", session_id)
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        with client.stream(
            "POST", path, json={**body, "stream": True}, params=params
        ) as r:
            if r.status_code >= 400:
                r.read()
                answer(r)
                return
            out = sys.stdout.buffer
            for chunk in r.iter_bytes():
                out.write(chunk)
                out.flush()


def answer(r: httpx.Response) -> Any:
    """A call's answer, or its failure in the call's own words: a
    refused or failed call prints its errno and exits 1, with the
    policy's reason on a line of its own.

    Args:
        r (httpx.Response): the daemon's response.
    """
    if r.status_code >= 400:
        error = error_of(r.text)
        if error is not None and "errno" in error:
            typer.echo(f"{error['message']} ({error['errno']})", err=True)
            refusal = error.get("refusal")
            if isinstance(refusal, dict):
                typer.echo(f"policy denied: {refusal['reason']}", err=True)
            raise typer.Exit(code=1)
    return handle_response(r)


def _explained(said: dict[str, Any]) -> str:
    verdict = said["outcome"]
    if said["reason"]:
        verdict += f": {said['reason']}"
    line = f"{said['call']} {' '.join(said['paths'])}  [{verdict}]"
    if said["error"]:
        line += f"  {said['error']}"
    return line


def _text(result: str) -> str:
    return base64.b64decode(result).decode(errors="replace")


def _lines(result: list[str]) -> str:
    return "\n".join(result)


HUMAN: dict[str, Callable[[Any], str]] = {
    "getxattr": _text,
    "readdir": _lines,
    "list_files": _lines,
    "listxattr": _lines,
    "readlink": str,
}


def _parameter(call: VfsCall, name: str) -> inspect.Parameter:
    schema = call.params[name]
    default: Any
    if schema is BYTES:
        default = typer.Option(
            None, f"--{name}", help=f"The {name} as text; stdin when absent."
        )
        kind: Any = str | None
    elif schema is FLAG:
        default, kind = typer.Option(False, f"--{name}"), bool
    elif name in call.required:
        default = typer.Argument(...)
        kind = int if schema is INTEGER else str
    else:
        default = typer.Option(None, f"--{name}")
        kind = (int if schema in (INTEGER, SIZE) else str) | None
    return inspect.Parameter(
        name, inspect.Parameter.KEYWORD_ONLY, default=default, annotation=kind
    )


def _value(call: VfsCall, name: str, value: Any) -> Any:
    schema = call.params[name]
    if schema is BYTES:
        data = sys.stdin.buffer.read() if value is None else value.encode()
        return base64.b64encode(data).decode()
    if schema is OWNER and isinstance(value, str) and value.isdigit():
        return int(value)
    return value


def command(call: VfsCall) -> Callable[..., None]:
    """The ``mirage workspace vfs <call>`` command for one call: the call's
    required arguments in order, then an option for each of the rest.

    Args:
        call (VfsCall): the call.
    """

    def run(**given: Any) -> None:
        workspace_id = given.pop("workspace_id")
        session_id = given.pop("session_id")
        explain = given.pop("explain")
        # A read prints the file's bytes as they arrive; --json keeps the
        # JSON answer.
        as_json = given.pop("json_output", False)
        body = {
            name: _value(call, name, value)
            for name, value in given.items()
            if call.params[name] is BYTES
            or (
                value is not None
                and not (call.params[name] is FLAG and value is False)
            )
        }
        if call.name == "read" and not as_json and not explain:
            _read_to_stdout(workspace_id, body, session_id)
            return
        result = answer(
            post(workspace_id, f"vfs/{call.name}", body, session_id, explain)
        )
        if result is not None:
            emit(result, human=_explained if explain else HUMAN.get(call.name))

    parameters = [_parameter(call, name) for name in call.params] + [
        inspect.Parameter(
            name,
            inspect.Parameter.KEYWORD_ONLY,
            default=default,
            annotation=kind,
        )
        for name, default, kind in (
            ("workspace_id", WORKSPACE, str | None),
            ("session_id", SESSION, str | None),
            ("explain", EXPLAIN, bool),
        )
    ]
    if call.name == "read":
        parameters.append(
            inspect.Parameter(
                "json_output",
                inspect.Parameter.KEYWORD_ONLY,
                default=typer.Option(
                    False,
                    "--json",
                    help="Print the JSON answer, the bytes in base64.",
                ),
                annotation=bool,
            )
        )
    vars(run)["__signature__"] = inspect.Signature(parameters)
    run.__annotations__ = {p.name: p.annotation for p in parameters}
    run.__doc__ = call.description
    return run


for _call in VFS_CALLS:
    app.command(_call.name.replace("_", "-"))(command(_call))
