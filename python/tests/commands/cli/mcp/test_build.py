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

import subprocess
import sys

import pytest
from mcp import types

from mirage.accessor.mcp import MCPAccessor
from mirage.commands.cli.mcp import (
    MCPSource,
    MCPTool,
    MCPToolsError,
    build_cli,
    mcp_cli,
)
from mirage.core.mcp.config import MCPConfig
from mirage.core.mcp.constants import MAX_REPLY, MAX_TOOLS
from tests.fixtures.mcp_server import TITLE, served_mcp

SCHEMA = {
    "type": "object",
    "properties": {"name": {"type": "string"}},
    "required": ["name"],
}


def _tool(name: str, read_only: bool = False) -> MCPTool:
    return MCPTool(
        name=name,
        description="Add an item.\nIt lands last.",
        input_schema=SCHEMA,
        annotations={"readOnlyHint": True} if read_only else {},
    )


SOURCE = MCPSource(
    title="Items", tools=(_tool("list_items", True), _tool("add_item"))
)


def test_one_subcommand_per_tool_with_dashes_for_underscores():
    cli = build_cli(SOURCE)
    assert [s.name for s in cli.spec.subcommands] == ["list-items", "add-item"]
    assert set(cli.handlers) == {"list-items", "add-item"}
    assert cli.spec.description == "Items"


def test_a_subcommand_takes_one_optional_json_operand():
    (argument,) = build_cli(SOURCE).spec.subcommands[1].arguments
    assert (argument.names, argument.nargs) == (("JSON",), "?")


def test_the_help_carries_the_compact_schema_and_the_long_description():
    leaf = build_cli(SOURCE).spec.subcommands[1]
    assert leaf.description == "Add an item."
    assert leaf.epilog.startswith("It lands last.\n\n")
    assert (
        '{"type":"object","properties":{"name":{"type":"string"}},'
        '"required":["name"]}' in leaf.epilog
    )


def test_write_follows_the_read_only_hint():
    cli = build_cli(SOURCE)
    assert cli.handlers["list-items"].write is False
    assert cli.handlers["add-item"].write is True


def test_the_cli_carries_its_source_config_model_and_accessor():
    cli = build_cli(SOURCE)
    assert cli.mcp == SOURCE
    assert cli.config_model is MCPConfig
    assert cli.accessor is MCPAccessor


@pytest.mark.parametrize(
    "names, wording",
    [
        ((), "lists no tools"),
        (("-x",), "would become the option '-x'"),
        (("a_b", "a-b"), "both become 'a-b'"),
    ],
)
def test_a_tool_list_no_cli_can_be_made_from_is_refused(names, wording):
    source = MCPSource(title="t", tools=tuple(_tool(n) for n in names))
    with pytest.raises(MCPToolsError, match=wording):
        build_cli(source)


def test_a_tool_list_past_the_tool_cap_is_refused():
    names = [f"t{i}" for i in range(MAX_TOOLS + 1)]
    assert len(
        build_cli(MCPSource("t", tuple(map(_tool, names[1:])))).handlers
    )
    with pytest.raises(
        MCPToolsError, match=f"the server lists more than {MAX_TOOLS} tools"
    ):
        build_cli(MCPSource(title="t", tools=tuple(map(_tool, names))))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content_type", ["application/json", "text/event-stream"]
)
async def test_a_tool_list_past_the_reply_cap_is_refused(content_type):
    async with served_mcp() as fake:
        fake.oversized["tools/list"] = content_type
        with pytest.raises(MCPToolsError) as caught:
            await mcp_cli(fake.bearer_config())
    assert str(caught.value) == (
        f"cannot list the server's tools: "
        f"MCP server reply exceeds {MAX_REPLY} bytes"
    )


@pytest.mark.asyncio
async def test_the_reply_cap_spans_every_page_of_a_tool_list():
    third = "x" * (MAX_REPLY // 3)
    tools = [
        types.Tool(
            name=f"t{i}", description=third, input_schema={"type": "object"}
        )
        for i in range(3)
    ]
    async with served_mcp(tools[:2]) as fake:
        assert len((await mcp_cli(fake.bearer_config())).handlers) == 2
    async with served_mcp(tools) as fake:
        with pytest.raises(MCPToolsError, match="reply exceeds"):
            await mcp_cli(fake.bearer_config())


@pytest.mark.asyncio
async def test_mcp_cli_reads_every_page_of_the_tool_list():
    async with served_mcp() as fake:
        cli = await mcp_cli(fake.bearer_config())
    assert [s.name for s in cli.spec.subcommands] == [
        "list-items",
        "add-item",
        "fail-always",
        "wait-forever",
        "echo-args",
    ]
    assert cli.spec.description == TITLE
    assert cli.handlers["list-items"].write is False
    assert cli.handlers["add-item"].write is True


@pytest.mark.asyncio
async def test_a_tool_list_reads_to_64_pages_and_no_further():
    async with served_mcp() as fake:
        config = fake.bearer_config()
        fake.pages = 64
        assert len((await mcp_cli(config)).spec.subcommands) == 5
        fake.pages = 65
        with pytest.raises(MCPToolsError, match="64 pages"):
            await mcp_cli(config)


@pytest.mark.asyncio
async def test_a_tool_listing_has_one_deadline_across_its_pages(monkeypatch):
    monkeypatch.setattr("mirage.accessor.mcp.TIMEOUT", 1.0)
    async with served_mcp() as fake:
        fake.pages, fake.page_delay = 5, 0.4
        with pytest.raises(MCPToolsError) as caught:
            await mcp_cli(fake.bearer_config())
    assert str(caught.value) == (
        "cannot list the server's tools: MCP server timed out"
    )


@pytest.mark.asyncio
async def test_a_page_the_server_repeats_ends_the_list():
    async with served_mcp() as fake:
        fake.repeating = True
        cli = await mcp_cli(fake.bearer_config())
    assert [s.name for s in cli.spec.subcommands] == ["list-items", "add-item"]


@pytest.mark.asyncio
async def test_a_refused_listing_never_repeats_the_token():
    async with served_mcp() as fake:
        with pytest.raises(MCPToolsError) as caught:
            await mcp_cli(
                {
                    "url": fake.url,
                    "auth": {"type": "bearer", "token": "s3cr3t-x"},
                }
            )
    assert "cannot list the server's tools" in str(caught.value)
    assert "s3cr3t-x" not in str(caught.value)


def test_loading_a_workspace_leaves_the_mcp_sdk_unimported():
    probe = (
        "import sys, mirage.workspace.workspace, mirage.commands.cli.types;"
        "print('mcp' in sys.modules)"
    )
    out = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() == "False"
