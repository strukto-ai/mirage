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

import functools
from collections.abc import Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.gws.methods import (BESPOKE_COMMANDS, GWS_METHODS,
                                                 SERVICE_RESOURCES,
                                                 gws_method_description)
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SERVICE_ORDER: tuple[str, ...] = ("drive", "sheets", "docs", "slides", "gmail")


def service_names() -> list[str]:
    """List the gws services in a stable display order.

    Returns:
        list[str]: service names present in the method table.
    """
    present = {m.service for m in GWS_METHODS}
    return [s for s in SERVICE_ORDER if s in present]


def render_service_methods(service: str) -> str:
    """Render one service's Discovery methods and ``+`` helpers.

    Mirrors `gws <service> --help` in the official CLI, which lists the
    generated API methods and the hand-written helpers together.

    Args:
        service (str): the gws service name.

    Returns:
        str: the listing body, without a trailing newline.
    """
    methods = [m for m in GWS_METHODS if m.service == service]
    helpers = [(n, d) for n, d in BESPOKE_COMMANDS
               if n.startswith(f"gws {service} ")]
    names = [m.command_name for m in methods] + [n for n, _ in helpers]
    width = max(len(n) for n in names) if names else 0
    lines = ["Methods:"]
    for m in methods:
        lines.append(f"  {m.command_name.ljust(width)}  "
                     f"{gws_method_description(m)}")
    if helpers:
        lines.append("")
        lines.append("Helpers:")
        for name, desc in helpers:
            lines.append(f"  {name.ljust(width)}  {desc}")
    lines.append("")
    lines.append("Run '<command> --help' for one command's flags.")
    return "\n".join(lines)


def render_services() -> str:
    """Render the service index shown by ``gws --help``.

    Returns:
        str: the listing body, without a trailing newline.
    """
    names = service_names()
    width = max(len(n) for n in names) if names else 0
    lines = ["Services:"]
    for name in names:
        count = sum(1 for m in GWS_METHODS if m.service == name)
        lines.append(f"  {name.ljust(width)}  {count} API methods")
    lines.append("")
    lines.append("Run 'gws <service> --help' to list a service's commands.")
    return "\n".join(lines)


_ROOT_DESCRIPTION = "Google Workspace API commands"


async def run_help(
    body: str,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    **_flags: object,
) -> tuple[ByteSource | None, IOResult]:
    """Print one prerendered help listing.

    Bound to its listing with `functools.partial`, mirroring how
    `run_gws_method` is bound to its method.

    Args:
        body (str): the listing to print, without a trailing newline.
        accessor (Accessor): the bound mount handle, unused.
        paths (list[PathSpec]): unused; the command takes no operands.
        texts (str): unused positional operands.
    """
    return yield_bytes((body + "\n").encode()), IOResult()


def _help_command(
    name: str,
    description: str,
    body: str,
    resource: str,
) -> Callable[..., object]:
    """Register one help command against one resource.

    Args:
        name (str): the command name, `gws` or `gws <service>`.
        description (str): the one-line description for `--help`.
        body (str): the listing, used as both output and help epilog.
        resource (str): the single resource this registration serves.
    """
    spec = CommandSpec(description=description, epilog=body)
    return command(name, resource=[resource],
                   spec=spec)(functools.partial(run_help, body))


def gws_help_commands(resource: str) -> list[Callable[..., object]]:
    """Build the `gws` and `gws <service>` help commands for one resource.

    Each command is registered against the single resource asked for, so a
    mount only ever answers for the services it can actually reach: a
    gdocs-only mount must not serve `gws gmail`. This mirrors the
    TypeScript wiring, which filters the same registrations by resource.

    Args:
        resource (str): the mounted resource name.
    """
    out = [
        _help_command("gws", _ROOT_DESCRIPTION, render_services(), resource)
    ]
    for service in service_names():
        if resource not in SERVICE_RESOURCES[service]:
            continue
        out.append(
            _help_command(f"gws {service}", f"Google {service} API commands",
                          render_service_methods(service), resource))
    return out


__all__ = [
    "gws_help_commands",
    "render_service_methods",
    "render_services",
    "run_help",
    "service_names",
]
