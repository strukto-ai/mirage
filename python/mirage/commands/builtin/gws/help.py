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


ROOT_SPEC = CommandSpec(
    description="Google Workspace API commands",
    epilog=render_services(),
)


def make_service_help_command(service: str) -> Callable[..., object]:
    """Build the ``gws <service>`` help command for one service.

    Args:
        service (str): the gws service name.
    """
    spec = CommandSpec(
        description=f"Google {service} API commands",
        epilog=render_service_methods(service),
    )
    body = render_service_methods(service)

    async def run(
        accessor: Accessor,
        paths: list[PathSpec],
        *texts: str,
        **_flags: object,
    ) -> tuple[ByteSource | None, IOResult]:
        return yield_bytes((body + "\n").encode()), IOResult()

    run.__name__ = f"gws_{service}_help"
    run.__doc__ = (
        f"List the gws {service} commands.\n\n"
        "    Args:\n"
        "        accessor (Accessor): bound mount handle, unused.\n"
        "        paths (list[PathSpec]): unused; takes no operands.\n"
        "        texts (str): unused positional operands.\n"
        "    ")
    return command(f"gws {service}",
                   resource=SERVICE_RESOURCES[service],
                   spec=spec)(run)


@command("gws",
         resource=["gdrive", "gsheets", "gdocs", "gslides", "gmail"],
         spec=ROOT_SPEC)
async def gws_root(
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    **_flags: object,
) -> tuple[ByteSource | None, IOResult]:
    """List the gws services so the surface is discoverable.

    Args:
        accessor (Accessor): the bound mount handle, unused.
        paths (list[PathSpec]): unused; the command takes no operands.
        texts (str): unused positional operands.
    """
    return yield_bytes((render_services() + "\n").encode()), IOResult()


GWS_SERVICE_HELP_COMMANDS = [
    make_service_help_command(s) for s in service_names()
]

__all__ = [
    "GWS_SERVICE_HELP_COMMANDS",
    "gws_root",
    "render_service_methods",
    "render_services",
    "service_names",
]
