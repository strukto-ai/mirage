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
import math
import sys
import time
from enum import StrEnum
from typing import Any, Callable, NoReturn, cast

import httpx
import typer

from mirage.utils.yaml import dump_yaml


class Output(StrEnum):
    """What ``get -o`` prints instead of its default: YAML, a file
    ``create -f`` and ``update -f`` read back."""

    YAML = "yaml"


OUTPUT = typer.Option(
    None, "--output", "-o", help="yaml: a file create -f and update -f read."
)

ID_HELP = "The ID, or the name: a name is unique, so it works as an ID."


def emit(obj: Any, human: Callable[[Any], str] | None = None) -> None:
    """Print ``obj`` to stdout.

    Renders ``human(obj)`` when stdout is a TTY and a formatter is
    given; otherwise pretty JSON, so ``| jq`` keeps working.

    Args:
        obj (Any): Value to print.
        human (Callable | None): Optional table/describe formatter.
    """
    if human is not None and sys.stdout.isatty():
        typer.echo(human(obj))
        return
    typer.echo(json.dumps(obj, indent=2, default=str, ensure_ascii=False))


def show(obj: Any, output: Output | None, human: Callable[[Any], str]) -> None:
    """Print ``obj`` as YAML when ``-o yaml`` asks, else as ``emit`` does.

    Args:
        obj (Any): the answer.
        output (Output | None): ``yaml``, or None.
        human (Callable[[Any], str]): the terminal formatter for ``emit``.
    """
    if output is Output.YAML:
        typer.echo(dump_yaml(obj), nl=False)
        return
    emit(obj, human=human)


def fail(message: str, exit_code: int = 1) -> NoReturn:
    typer.echo(message, err=True)
    raise typer.Exit(code=exit_code)


def exit_code_from_response(r: Any) -> int:
    if not isinstance(r, dict):
        return 0
    inner = r if "exit_code" in r else r.get("result")
    if isinstance(inner, dict) and "exit_code" in inner:
        code = inner["exit_code"]
        if isinstance(code, bool) or not isinstance(code, (int, float)):
            return 0
        if not math.isfinite(code):
            return 0
        return max(0, min(255, int(code)))
    status = r.get("status")
    if status in ("failed", "canceled"):
        return 2
    return 0


def handle_response(r: httpx.Response) -> dict[str, Any] | list[Any]:
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except ValueError:
            detail = r.text
        if not isinstance(detail, str):
            detail = json.dumps(detail, ensure_ascii=False)
        fail(f"error {r.status_code}: {detail}", exit_code=2)
    if not r.content:
        return {}
    return cast(dict[str, Any] | list[Any], r.json())


def format_age(epoch: float) -> str:
    """Render a Unix timestamp as a short relative age (``2m``, ``3h``)."""
    delta = max(0, time.time() - epoch)
    if delta < 60:
        return f"{int(delta)}s"
    if delta < 3600:
        return f"{int(delta // 60)}m"
    if delta < 86400:
        return f"{int(delta // 3600)}h"
    return f"{int(delta // 86400)}d"


def format_table(headers: list[str], rows: list[list[str]]) -> str:
    """Format a left-aligned table with two-space column gutters."""
    if not rows:
        return "  ".join(headers)
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    lines = ["  ".join(h.ljust(w) for h, w in zip(headers, widths)).rstrip()]
    for row in rows:
        lines.append(
            "  ".join(c.ljust(w) for c, w in zip(row, widths)).rstrip()
        )
    return "\n".join(lines)
