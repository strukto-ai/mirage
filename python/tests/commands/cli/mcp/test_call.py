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

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from mcp import types

from mirage import Workspace
from mirage.commands.cli.mcp import mcp_cli
from mirage.commands.cli.mcp.call import render
from mirage.core.mcp.constants import MAX_REPLY, REPLY_ENCODING
from mirage.policy import NetworkContext, Policy
from mirage.vfs.ram import RAMVFS
from tests.fixtures.mcp_server import TOKEN, FakeMCP, served_mcp


class _Listening(Policy):
    async def pre_network(self, ctx: NetworkContext) -> None:
        return None


@asynccontextmanager
async def installed(
    policy: Policy | None = None,
) -> AsyncIterator[tuple[Workspace, FakeMCP]]:
    async with served_mcp() as fake:
        config = fake.bearer_config()
        ws = Workspace({"/data": RAMVFS()})
        if policy is not None:
            ws.policies.add(policy)
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


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [None, _Listening()], ids=["kept", "own"])
async def test_a_call_past_the_timeout_exits_1_and_says_so(
    monkeypatch, policy
):
    async with installed(policy) as (ws, fake):
        monkeypatch.setattr("mirage.accessor.mcp.TIMEOUT", 1.0)
        result = await ws.shell("fx wait-forever")
        before = fake.opens()
        after = await ws.shell("fx list-items")
        assert fake.opens() == before + 1
    assert (result.exit_code, result.stderr) == (
        1,
        b"wait-forever: MCP server timed out\n",
    )
    assert after.stdout == b"apple\nbanana\n"


@pytest.mark.asyncio
async def test_a_server_that_never_opens_a_session_times_out(monkeypatch):
    monkeypatch.setattr("mirage.accessor.mcp.TIMEOUT", 1.0)
    monkeypatch.setattr("mcp.client.session.DISCOVER_TIMEOUT_SECONDS", 1.5)
    held: list[asyncio.StreamWriter] = []
    silent = await asyncio.start_server(
        lambda _, writer: held.append(writer), "127.0.0.1", 0
    )
    port = silent.sockets[0].getsockname()[1]
    async with served_mcp() as fake:
        cli = await mcp_cli(fake.bearer_config())
    ws = Workspace({"/data": RAMVFS()})
    ws.register_cli("fx", cli, {"url": f"http://127.0.0.1:{port}/mcp"})
    try:
        result = await ws.shell("fx list-items")
    finally:
        await ws.close()
        for writer in held:
            writer.close()
        silent.close()
        await silent.wait_closed()
    assert (result.exit_code, result.stderr) == (
        1,
        b"list-items: MCP server timed out\n",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [None, _Listening()], ids=["kept", "own"])
@pytest.mark.parametrize(
    "content_type", ["application/json", "text/event-stream"]
)
async def test_a_reply_past_the_cap_exits_1_and_says_so(
    monkeypatch, policy, content_type
):
    monkeypatch.setattr("mirage.accessor.mcp.TIMEOUT", 20.0)
    async with installed(policy) as (ws, fake):
        fake.oversized["tools/call"] = content_type
        result = await ws.shell("fx list-items")
        fake.oversized.clear()
        after = await ws.shell("fx list-items")
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        b"",
        f"list-items: MCP server reply exceeds {MAX_REPLY} bytes\n".encode(),
    )
    assert after.stdout == b"apple\nbanana\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
async def test_a_compressed_reply_is_inflated_once(encoding):
    async with installed() as (ws, fake):
        fake.encoding = encoding
        result = await ws.shell("fx list-items")
    assert (result.exit_code, result.stdout) == (0, b"inflated\n")
    assert {r["accept-encoding"] for r in fake.requests} == {"identity"}


@pytest.mark.asyncio
async def test_a_compressed_reply_is_capped_once_inflated():
    async with installed() as (ws, fake):
        fake.encoding, fake.padding = "gzip", MAX_REPLY
        result = await ws.shell("fx list-items")
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        b"",
        f"list-items: MCP server reply exceeds {MAX_REPLY} bytes\n".encode(),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "encoding, damage",
    [
        ("br", None),
        ("gzip, br", None),
        ("gzip", "truncated"),
        ("gzip", "garbled"),
    ],
)
async def test_a_reply_the_client_cannot_inflate_exits_1(encoding, damage):
    async with installed() as (ws, fake):
        fake.encoding, fake.damage = encoding, damage
        result = await ws.shell("fx list-items")
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        b"",
        f"list-items: {REPLY_ENCODING}\n".encode(),
    )


@pytest.mark.asyncio
async def test_bytes_after_a_compressed_reply_ends_exit_1():
    async with installed() as (ws, fake):
        fake.encoding, fake.damage, fake.padding = "gzip", "trailing", 196608
        result = await asyncio.wait_for(ws.shell("fx list-items"), 10)
    assert (result.exit_code, result.stdout, result.stderr) == (
        1,
        b"",
        f"list-items: {REPLY_ENCODING}\n".encode(),
    )


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
