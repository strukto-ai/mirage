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
from collections.abc import Mapping, Sequence

from mirage.accessor.mcp import MCPAccessor, refusal, timed_out
from mirage.commands.cli.mcp.call import call_tool, causes, command_name
from mirage.commands.cli.mcp.constants import NAME
from mirage.commands.cli.mcp.errors import MCPToolsError
from mirage.commands.cli.mcp.types import MCPSource, MCPTool
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.mcp.config import MCPConfig
from mirage.core.mcp.constants import MAX_TOOLS
from mirage.core.render.json import compact_json_text
from mirage.types import JsonValue


def check_names(tools: Sequence[MCPTool]) -> None:
    """Refuse a tool list no CLI can be made from.

    Args:
        tools (Sequence[MCPTool]): the server's tools.

    Raises:
        MCPToolsError: no tools, more than ``MAX_TOOLS``, a name that
            reads as an option, or two names that become the same
            subcommand.
    """
    if not tools:
        raise MCPToolsError("the server lists no tools")
    if len(tools) > MAX_TOOLS:
        raise MCPToolsError(f"the server lists more than {MAX_TOOLS} tools")
    seen: dict[str, str] = {}
    for tool in tools:
        command = command_name(tool.name)
        if command.startswith("-"):
            raise MCPToolsError(
                f"tool {tool.name!r} would become the option {command!r}"
            )
        if command in seen:
            raise MCPToolsError(
                f"tools {seen[command]!r} and {tool.name!r} "
                f"both become {command!r}"
            )
        seen[command] = tool.name


def leaf(tool: MCPTool) -> CommandSpec:
    """One tool's subcommand: its first line, the rest and its schema.

    Args:
        tool (MCPTool): the tool.
    """
    first, _, rest = tool.description.strip().partition("\n")
    schema = compact_json_text(tool.input_schema)
    return CommandSpec(
        name=command_name(tool.name),
        description=first,
        epilog=f"{rest.strip()}\n\nJSON arguments (schema):\n{schema}".lstrip(),
        arguments=(
            Argument(
                "JSON", nargs="?", help="the tool's arguments as one object"
            ),
        ),
    )


def build_cli(source: MCPSource) -> CLI:
    """The CLI an MCP server's tool list becomes, one subcommand a tool.

    Args:
        source (MCPSource): the server's title and tools.

    Raises:
        MCPToolsError: the tool list cannot be made into a CLI.
    """
    check_names(source.tools)
    return CLI(
        spec=CommandSpec(
            name=NAME,
            description=source.title,
            subcommands=tuple(leaf(tool) for tool in source.tools),
        ),
        handlers={
            command_name(tool.name): CLIHandler(
                fn=functools.partial(call_tool, tool.name),
                write=tool.annotations.get("readOnlyHint") is not True,
            )
            for tool in source.tools
        },
        config_model=MCPConfig,
        accessor=MCPAccessor,
        mcp=source,
    )


async def mcp_cli(config: MCPConfig | Mapping[str, JsonValue]) -> CLI:
    """Read a streamable-HTTP MCP server's tools and build its CLI.

    Install it with ``ws.register_cli(name, cli, config)``.

    Args:
        config (MCPConfig | Mapping[str, JsonValue]): the server's URL
            and auth.

    Raises:
        ValidationError: the config is not an MCPConfig.
        MCPToolsError: the server could not be listed, or its tools
            cannot be made into a CLI.
    """
    validated = MCPConfig.model_validate(config)
    try:
        title, tools = await MCPAccessor(validated).list_tools()
    except Exception as error:
        reason = refusal(error) or (
            "MCP server timed out"
            if timed_out(error)
            else "; ".join(causes(error))
        )
        raise MCPToolsError(
            f"cannot list the server's tools: {reason}"
        ) from error
    return build_cli(
        MCPSource(
            title=title,
            tools=tuple(
                MCPTool(
                    name=tool.name,
                    description=tool.description or "",
                    input_schema=tool.input_schema,
                    annotations=(
                        tool.annotations.model_dump(
                            by_alias=True, exclude_none=True
                        )
                        if tool.annotations
                        else {}
                    ),
                )
                for tool in tools
            ),
        )
    )
