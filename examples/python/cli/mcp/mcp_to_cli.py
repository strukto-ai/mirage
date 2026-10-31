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

import argparse
import asyncio
import os
import pprint
import re
import stat
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import IO, Any

from mcp import Client, StdioServerParameters, stdio_client

# Turns any MCP server into a real CLI: one subcommand per tool, named
# after the tool with dashes, taking the tool's arguments as one JSON
# object. The generated file runs on its own with uv:
#
#   python mcp_to_cli.py --name grafana --out grafana \
#       -- docker run --rm -i -e GRAFANA_URL mcp/grafana -t stdio
#   ./grafana search-dashboards '{"query": "api"}'

Server = dict[str, Any]
Tool = dict[str, Any]

NAME_PATTERN = re.compile(r"[a-z][a-z0-9-]*")
PLACEHOLDER = re.compile(r"__(NAME|NAME_LITERAL|ATTR|SERVER|TOOLS)__")


def connect(server: Server, errlog: IO[str]) -> Client:
    """Open a client to a stdio command or a streamable HTTP URL.

    Args:
        server (Server): {"command": [...], "cwd": "..."} or {"url": "..."}.
        errlog (IO[str]): file receiving a stdio server's own stderr.
    """
    if "url" in server:
        return Client(server["url"])
    command = server["command"]
    params = StdioServerParameters(
        command=command[0],
        args=command[1:],
        env=dict(os.environ),
        cwd=server["cwd"],
    )
    return Client(stdio_client(params, errlog=errlog))


def causes(error: BaseException) -> Iterator[str]:
    """The leaf errors inside an exception group, one line each.

    Args:
        error (BaseException): what connecting or calling raised.
    """
    if isinstance(error, BaseExceptionGroup):
        for inner in error.exceptions:
            yield from causes(inner)
    else:
        yield f"{type(error).__name__}: {error}"


async def list_tools(server: Server, errlog: IO[str]) -> list[Tool]:
    """Read every tool the server lists, following its pages.

    Args:
        server (Server): where the MCP server is.
        errlog (IO[str]): file receiving a stdio server's own stderr.
    """
    tools: list[Tool] = []
    async with connect(server, errlog) as client:
        cursor = None
        while True:
            page = await client.list_tools(cursor=cursor)
            tools += [
                {
                    "name": tool.name,
                    "description": tool.description or "",
                    "inputSchema": tool.input_schema,
                    "annotations": (
                        tool.annotations.model_dump(
                            by_alias=True, exclude_none=True
                        )
                        if tool.annotations
                        else {}
                    ),
                }
                for tool in page.tools
            ]
            cursor = page.next_cursor
            if not cursor:
                return tools


async def fetch_tools(server: Server) -> list[Tool]:
    """List the server's tools, showing its own log if that fails.

    Args:
        server (Server): where the MCP server is.
    """
    with tempfile.TemporaryFile("w+") as errlog:
        try:
            return await list_tools(server, errlog)
        except Exception as error:
            errlog.seek(0)
            sys.stderr.write("".join(errlog.readlines()[-20:]))
            reason = "; ".join(causes(error))
            raise SystemExit(f"cannot list the server's tools: {reason}")


def command_name(tool_name: str) -> str:
    """The subcommand a tool becomes: underscores read as dashes.

    Args:
        tool_name (str): the MCP tool name.
    """
    return tool_name.replace("_", "-")


def check_names(tools: list[Tool]) -> None:
    """Refuse a tool list no CLI can be made from.

    Args:
        tools (list[Tool]): the server's tools.
    """
    if not tools:
        raise SystemExit("the server lists no tools")
    seen: dict[str, str] = {}
    for tool in tools:
        command = command_name(tool["name"])
        if command.startswith("-"):
            raise SystemExit(
                f"tool {tool['name']!r} would become the option {command!r}"
            )
        if command in seen:
            raise SystemExit(
                f"tools {seen[command]!r} and {tool['name']!r} "
                f"both become {command!r}"
            )
        seen[command] = tool["name"]


def server_from_args(args: argparse.Namespace) -> Server:
    """Read --url or the command after `--` into a server description.

    A stdio server starts in the caller's directory unless --cwd names
    one, so a command such as `npx -y pkg` runs on any machine.

    Args:
        args (argparse.Namespace): the parsed generator arguments.
    """
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if bool(args.url) == bool(command):
        raise SystemExit("give either --url or a server command after --")
    if args.url:
        return {"url": args.url}
    cwd = os.path.abspath(args.cwd) if args.cwd else None
    return {"command": command, "cwd": cwd}


def cli_name(value: str) -> str:
    """Accept a command name that is one lowercase word.

    Args:
        value (str): the --name value.
    """
    if not NAME_PATTERN.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"{value!r} is not a lowercase word like grafana or my-tool"
        )
    return value


def parser(prog: str, description: str) -> argparse.ArgumentParser:
    """The arguments both generators take.

    Args:
        prog (str): the generator's name.
        description (str): what it generates.
    """
    p = argparse.ArgumentParser(prog=prog, description=description)
    p.add_argument("--name", required=True, type=cli_name, help="command name")
    p.add_argument("--out", required=True, help="file to write")
    p.add_argument("--url", help="streamable HTTP endpoint of the server")
    p.add_argument(
        "--cwd", help="directory a stdio server starts in, if it needs one"
    )
    p.add_argument(
        "command", nargs=argparse.REMAINDER, help="stdio server command"
    )
    return p


def fill(template: str, name: str, server: Server, tools: list[Tool]) -> str:
    """Substitute the placeholders of a template in one pass.

    Args:
        template (str): generated source with __NAME__-style slots.
        name (str): the command name.
        server (Server): where the MCP server is.
        tools (list[Tool]): the tools it lists.
    """
    values = {
        "NAME": name,
        "NAME_LITERAL": repr(name),
        "ATTR": name.upper().replace("-", "_"),
        "SERVER": pprint.pformat(server, sort_dicts=False),
        "TOOLS": pprint.pformat(tools, width=79, sort_dicts=False),
    }
    return PLACEHOLDER.sub(lambda match: values[match.group(1)], template)


TEMPLATE = Path(__file__).with_name("real_cli.py.tmpl").read_text()


def main() -> None:
    args = parser(
        "mcp_to_cli", "Generate a CLI from an MCP server."
    ).parse_args()
    server = server_from_args(args)
    tools = asyncio.run(fetch_tools(server))
    check_names(tools)
    out = Path(args.out)
    out.write_text(fill(TEMPLATE, args.name, server, tools))
    out.chmod(out.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"wrote {out} with {len(tools)} commands", file=sys.stderr)


if __name__ == "__main__":
    main()
