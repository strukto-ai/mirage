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

import typer

from mirage.cli.output import emit, fail
from mirage.cli.settings import (get_config, list_config, resolved_config,
                                 set_config, unset_config)
from mirage.server.daemon_config import ALLOWED_KEYS, DaemonConfigError

app = typer.Typer(no_args_is_help=True,
                  help="Read and write daemon settings in config.toml.")


def _mask(key: str, value: str) -> str:
    if key == "auth_token" and value:
        return "***"
    return value


def _human_table(table: dict) -> str:
    return "\n".join(f"{k} = {v}" for k, v in table.items())


def _human_resolved(table: dict) -> str:
    return "\n".join(f"{k} = {e['value']}  ({e['origin']})"
                     for k, e in table.items())


def _list_resolved() -> None:
    try:
        resolved = resolved_config()
    except DaemonConfigError as e:
        fail(str(e), exit_code=2)
    payload = {}
    for key, (value, origin) in resolved.items():
        payload[key] = {"value": _mask(key, value), "origin": origin}
    emit(payload, human=_human_resolved)


def _list_file() -> None:
    try:
        table = list_config()
    except DaemonConfigError as e:
        fail(str(e), exit_code=2)
    unknown = sorted(set(table) - ALLOWED_KEYS)
    if unknown:
        typer.echo(
            "warning: unknown [daemon] keys (daemon will refuse to "
            f"start): {', '.join(unknown)}",
            err=True)
    emit(table, human=_human_table)


_RESOLVED_OPTION = typer.Option(False,
                                "--resolved",
                                help="show effective values and their origins")


@app.command("list")
def list_cmd(resolved: bool = _RESOLVED_OPTION) -> None:
    """Print every key in the config.toml [daemon] table.

    With --resolved, print the effective value of every key after
    applying precedence (env var > config file > default) and where
    each value came from. auth_token is masked.
    """
    if resolved:
        _list_resolved()
    else:
        _list_file()


@app.command("get")
def get_cmd(key: str = typer.Argument(..., help="config key")) -> None:
    """Print one [daemon] key's value from config.toml."""
    try:
        value = get_config(key)
    except DaemonConfigError as e:
        fail(str(e), exit_code=2)
    if value is None:
        fail(f"{key} is not set", exit_code=1)
    emit({key: value}, human=lambda d: str(d[key]))


@app.command("set")
def set_cmd(
        key: str = typer.Argument(..., help="config key"),
        value: str = typer.Argument(..., help="value to store"),
) -> None:
    """Write a [daemon] key to config.toml.

    Path settings take effect on the next daemon start/restart.
    """
    try:
        set_config(key, value)
    except DaemonConfigError as e:
        fail(str(e), exit_code=2)
    emit({key: value, "written": True}, human=lambda d: f"{key} = {value}")


@app.command("unset")
def unset_cmd(key: str = typer.Argument(..., help="config key")) -> None:
    """Remove a [daemon] key from config.toml."""
    try:
        unset_config(key)
    except DaemonConfigError as e:
        fail(str(e), exit_code=2)
    emit({key: None, "unset": True}, human=lambda d: f"unset {key}")
