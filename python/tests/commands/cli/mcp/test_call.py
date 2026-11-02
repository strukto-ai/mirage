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

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from mcp import types

from mirage import Workspace
from mirage.commands.cli.mcp import mcp_cli
from mirage.commands.cli.mcp.call import render
from mirage.vfs.ram import RAMVFS
from tests.fixtures.mcp_server import TOKEN, FakeMCP, served_mcp


@asynccontextmanager
async def installed() -> AsyncIterator[tuple[Workspace, FakeMCP]]:
    async with served_mcp() as fake:
        config = fake.bearer_config()
        ws = Workspace({"/data": RAMVFS()})
        ws.register_cli("fx", await mcp_cli(config), config)
        try:
            yield ws, fake
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_arguments_reach_the_tool_verbatim():
    async with installed() as (ws, _):
        result = await ws.shell("""fx echo-args '{"b": 1, "a": [1, 2]}'""")
        empty = await ws.shell("fx echo-args")
    assert (result.exit_code, result.stdout) == (0, b'{"a": [1, 2], "b": 1}\n')
    assert empty.stdout == b"{}\n"


@pytest.mark.asyncio
async def test_text_blocks_print_as_text():
    async with installed() as (ws, _):
        result = await ws.shell("fx list-items")
    assert result.stdout == b"apple\nbanana\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operands, wording",
    [
        ("'{nope'", "echo-args: invalid JSON"),
        ("'[1]'", "echo-args: JSON must be an object"),
        ("'{}' '{}'", "echo-args: takes one JSON object"),
    ],
)
async def test_operands_that_are_not_one_json_object_exit_2(operands, wording):
    async with installed() as (ws, fake):
        before = len(fake.requests)
        result = await ws.shell(f"fx echo-args {operands}")
        after = len(fake.requests)
    assert result.exit_code == 2
    assert result.stderr.decode().startswith(wording)
    assert after == before


@pytest.mark.asyncio
async def test_a_tool_error_exits_1_with_its_text_on_stderr():
    async with installed() as (ws, _):
        result = await ws.shell("fx fail-always")
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        b"",
        b"boom\n",
    )


@pytest.mark.asyncio
async def test_a_tool_error_with_no_text_still_says_so():
    async with installed() as (ws, _):
        result = await ws.shell("""fx fail-always '{"quiet": true}'""")
    assert (result.exit_code, result.stderr) == (
        1,
        b"fail-always: the tool reported an error\n",
    )


@pytest.mark.asyncio
async def test_an_unreachable_server_exits_1_without_the_token():
    async with served_mcp() as fake:
        config = fake.bearer_config()
        cli = await mcp_cli(config)
    ws = Workspace({"/data": RAMVFS()})
    ws.register_cli("fx", cli, config)
    try:
        result = await ws.shell("fx list-items")
    finally:
        await ws.close()
    assert result.exit_code == 1
    assert result.stderr.decode().startswith("list-items: MCP server failed: ")
    assert TOKEN not in result.stderr.decode()


def _text(text: str) -> types.TextContent:
    return types.TextContent(type="text", text=text)


@pytest.mark.parametrize(
    "content, structured, out",
    [
        ([], None, ""),
        ([_text("a\n")], None, "a\n"),
        ([_text("a"), _text("b")], None, "a\nb\n"),
        ([_text("a")], {"n": 1}, "a\n"),
        ([], {"n": 1}, '{"n":1}\n'),
        (
            [
                types.ImageContent(
                    type="image", data="AA==", mime_type="image/png"
                )
            ],
            None,
            '{"type":"image","data":"AA==","mimeType":"image/png"}\n',
        ),
    ],
)
def test_render(content, structured, out):
    result = types.CallToolResult(
        content=content, structured_content=structured
    )
    assert render(result) == out
