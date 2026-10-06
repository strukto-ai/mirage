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
from mirage.cli.output import emit, handle_response
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
    ..., "--workspace_id", "--workspace", "-w", help="Workspace id."
)
SESSION = typer.Option(
    None, "--session_id", "--session", "-s", help="Session id."
)
EXPLAIN = typer.Option(
    False, "--explain", help="Say what the call would do; run nothing."
)


def post(
    workspace_id: str,
    route: str,
    body: dict[str, Any],
    session_id: str | None,
    explain: bool = False,
) -> httpx.Response:
    """Send one session call to the daemon.

    Args:
        workspace_id (str): the workspace.
        route (str): the call's route under the workspace.
        body (dict[str, Any]): its arguments.
        session_id (str | None): the session; None is the default.
        explain (bool): ask what the call would do instead.
    """
    params: dict[str, str] = {}
    if session_id:
        params["session_id"] = session_id
    if explain:
        params["explain"] = "true"
    path = f"/v1/workspaces/{quote(workspace_id, safe='')}/{route}"
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        return client.request("POST", path, json=body, params=params)


def answer(r: httpx.Response) -> Any:
    """A call's answer, or its failure in the call's own words: a
    refused or failed call prints its errno and exits 1, with the
    policy's reason on a line of its own.

    Args:
        r (httpx.Response): the daemon's response.
    """
    if r.status_code >= 400:
        try:
            body = r.json()
        except ValueError:
            body = {}
        if isinstance(body, dict) and "errno" in body:
            typer.echo(f"{body['detail']} ({body['errno']})", err=True)
            refusal = body.get("refusal")
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


def _text(key: str) -> Callable[[dict[str, Any]], str]:
    return lambda result: base64.b64decode(result[key]).decode(
        errors="replace"
    )


HUMAN: dict[str, Callable[[dict[str, Any]], str]] = {
    "read": _text("data_base64"),
    "getxattr": _text("value_base64"),
    "cat": lambda result: result["text"],
    "readdir": lambda result: "\n".join(result["entries"]),
    "list_files": lambda result: "\n".join(result["files"]),
    "listxattr": lambda result: "\n".join(result["names"]),
    "readlink": lambda result: result["target"],
}


def _flag_name(name: str) -> str:
    return name.removesuffix("_base64")


def _parameter(call: VfsCall, name: str) -> inspect.Parameter:
    schema = call.params[name]
    if schema is BYTES:
        option = typer.Option(
            None,
            f"--{_flag_name(name)}",
            help=f"The {_flag_name(name)} as text; stdin when absent.",
        )
        return inspect.Parameter(
            name,
            inspect.Parameter.KEYWORD_ONLY,
            default=option,
            annotation=str | None,
        )
    if schema is FLAG:
        option = typer.Option(False, f"--{name}")
        return inspect.Parameter(
            name,
            inspect.Parameter.KEYWORD_ONLY,
            default=option,
            annotation=bool,
        )
    kind: type = int if schema is INTEGER else str
    if name in call.required:
        return inspect.Parameter(
            name,
            inspect.Parameter.KEYWORD_ONLY,
            default=typer.Argument(...),
            annotation=kind,
        )
    if schema is SIZE:
        kind = int
    elif schema is OWNER:
        kind = str
    return inspect.Parameter(
        name,
        inspect.Parameter.KEYWORD_ONLY,
        default=typer.Option(None, f"--{name}"),
        annotation=kind | None,
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
    """The ``mirage vfs <call>`` command for one call: the call's
    required arguments in order, then an option for each of the rest.

    Args:
        call (VfsCall): the call.
    """

    def run(**given: Any) -> None:
        workspace_id = given.pop("workspace_id")
        session_id = given.pop("session_id")
        explain = given.pop("explain")
        body = {
            name: _value(call, name, value)
            for name, value in given.items()
            if value is not None
            and not (call.params[name] is FLAG and value is False)
        }
        result = answer(
            post(workspace_id, f"vfs/{call.name}", body, session_id, explain)
        )
        emit(result, human=_explained if explain else HUMAN.get(call.name))

    parameters = [_parameter(call, name) for name in call.params]
    parameters += [
        inspect.Parameter(
            "workspace_id",
            inspect.Parameter.KEYWORD_ONLY,
            default=WORKSPACE,
            annotation=str,
        ),
        inspect.Parameter(
            "session_id",
            inspect.Parameter.KEYWORD_ONLY,
            default=SESSION,
            annotation=str | None,
        ),
        inspect.Parameter(
            "explain",
            inspect.Parameter.KEYWORD_ONLY,
            default=EXPLAIN,
            annotation=bool,
        ),
    ]
    vars(run)["__signature__"] = inspect.Signature(parameters)
    run.__annotations__ = {p.name: p.annotation for p in parameters}
    run.__doc__ = call.description
    return run


for _call in VFS_CALLS:
    app.command(_call.name.replace("_", "-"))(command(_call))


def glob_cmd(
    pattern: str = typer.Argument(
        ..., help="Pathname pattern such as /**/*.py."
    ),
    workspace_id: str = WORKSPACE,
    session_id: str | None = SESSION,
) -> None:
    """Every path a pattern matches, as the session sees them."""
    result = answer(
        post(workspace_id, "glob", {"pattern": pattern}, session_id)
    )
    emit(result, human=lambda r: "\n".join(r["paths"]))
