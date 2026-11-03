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

import httpx2
import pytest
from mcp import types
from mcp.shared.exceptions import MCPError

from mirage import Workspace
from mirage.accessor.mcp import (
    CappedStream,
    MCPAccessor,
    answered,
    refusal,
    timed_out,
)
from mirage.commands.cli.mcp import build_cli, mcp_cli
from mirage.core.mcp.config import MCPConfig
from mirage.core.mcp.constants import REPLY_ENCODING, REPLY_TOO_LARGE
from mirage.policy import Deny, NetworkContext, Policy
from mirage.utils.abort import MirageAbortError
from mirage.vfs.ram import RAMVFS
from tests.fixtures.mcp_server import API_KEY, FakeMCP, served_mcp


class _Refuse(Policy):
    async def pre_network(self, ctx: NetworkContext) -> Deny:
        return Deny("not for this tenant")


class _Offline(Policy):
    async def pre_network(self, ctx: NetworkContext) -> Deny | None:
        return Deny("offline") if "offline" in ctx.line else None


@asynccontextmanager
async def kept(
    policy: Policy | None = None, legacy: bool = False
) -> AsyncIterator[tuple[Workspace, FakeMCP]]:
    async with served_mcp(legacy=legacy) as fake:
        config = fake.bearer_config()
        cli = await mcp_cli(config)
        ws = Workspace({"/data": RAMVFS()})
        if policy is not None:
            ws.policies.add(policy)
        ws.register_cli("fx", cli, config)
        fake.requests.clear()
        try:
            yield ws, fake
        finally:
            await ws.close()


@pytest.mark.parametrize(
    "auth, headers",
    [
        ({"type": "bearer", "token": "t"}, {"Authorization": "Bearer t"}),
        (
            {"type": "header", "name": "x-api-key", "token": "t"},
            {"x-api-key": "t"},
        ),
        (None, {}),
    ],
)
def test_auth_becomes_one_header(auth, headers):
    accessor = MCPAccessor(MCPConfig(url="http://x/mcp", auth=auth))
    assert accessor.headers() == headers


@pytest.mark.asyncio
async def test_list_and_call_both_carry_the_header():
    async with served_mcp() as fake:
        config = {
            "url": fake.url,
            "auth": {"type": "header", "name": "x-api-key", "token": API_KEY},
        }
        ws = Workspace({"/data": RAMVFS()})
        ws.register_cli("fx", await mcp_cli(config), config)
        listed = len(fake.requests)
        try:
            result = await ws.shell("fx list-items")
        finally:
            await ws.close()
    assert result.exit_code == 0
    assert listed > 0 and len(fake.requests) > listed
    assert {r["x-api-key"] for r in fake.requests} == {API_KEY}
    assert {r["authorization"] for r in fake.requests} == {""}


@pytest.mark.asyncio
@pytest.mark.parametrize("refusal", ["policy", "network"])
async def test_a_refused_network_never_reaches_the_server(refusal):
    async with served_mcp() as fake:
        config = fake.bearer_config()
        cli = await mcp_cli(config)
        fake.requests.clear()
        ws = Workspace({"/data": RAMVFS()}, network=refusal != "network")
        if refusal == "policy":
            ws.policies.add(_Refuse())
        ws.register_cli("fx", build_cli(cli.mcp), config)
        try:
            result = await ws.shell("fx list-items")
        finally:
            await ws.close()
    assert result.exit_code == 1
    assert fake.requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_calls_share_one_client(legacy):
    async with kept(legacy=legacy) as (ws, fake):
        for _ in range(3):
            assert (await ws.shell("fx list-items")).exit_code == 0
    assert fake.opens() == 1


@pytest.mark.asyncio
async def test_a_failed_call_drops_the_client_and_the_next_reopens():
    async with kept(legacy=True) as (ws, fake):
        assert (await ws.shell("fx list-items")).exit_code == 0
        fake.expire()
        assert (await ws.shell("fx list-items")).exit_code == 1
        assert (await ws.shell("fx list-items")).exit_code == 0
    assert fake.opens() == 2


@pytest.mark.asyncio
async def test_a_failed_open_is_followed_by_a_successful_call():
    async with kept(legacy=True) as (ws, fake):
        fake.down = True
        assert (await ws.shell("fx list-items")).exit_code == 1
        fake.down = False
        assert (await ws.shell("fx list-items")).exit_code == 0


@pytest.mark.asyncio
async def test_an_error_the_server_answered_keeps_the_client():
    async with kept(legacy=True) as (ws, fake):
        assert (await ws.shell("fx list-items")).exit_code == 0
        with pytest.raises(MCPError):
            await ws.clis()["fx"].accessor.call_tool("no_tool", {})
        assert (await ws.shell("fx list-items")).exit_code == 0
    assert fake.opens() == 1


@pytest.mark.parametrize(
    "error, kept",
    [
        (MCPError(types.INVALID_PARAMS, "x"), True),
        (MCPError(types.METHOD_NOT_FOUND, "x"), True),
        (MCPError(5, "x"), True),
        (MCPError(-32001, "x"), False),
        (MCPError(-32000, "x"), False),
        (MCPError(types.INVALID_REQUEST, "x"), False),
        (RuntimeError("x"), False),
    ],
)
def test_only_an_error_the_server_answered_keeps_the_client(error, kept):
    assert answered(error) is kept


@pytest.mark.parametrize(
    "error, expired",
    [
        (MCPError(types.REQUEST_TIMEOUT, "x"), True),
        (ExceptionGroup("g", [ValueError("x"), MCPError(-32001, "x")]), True),
        (ExceptionGroup("g", [ValueError("x")]), False),
        (MCPError(-32000, "x"), False),
    ],
)
def test_a_timeout_is_found_inside_any_exception_group(error, expired):
    assert timed_out(error) is expired


@pytest.mark.parametrize(
    "error, reason",
    [
        (
            MCPError(-32603, f"SSE stream failed: {REPLY_TOO_LARGE}"),
            REPLY_TOO_LARGE,
        ),
        (
            MCPError(
                -32700, f"Failed to parse JSON response: {REPLY_ENCODING}"
            ),
            REPLY_ENCODING,
        ),
        (
            ExceptionGroup(
                "g", [ValueError("x"), ValueError(REPLY_TOO_LARGE)]
            ),
            REPLY_TOO_LARGE,
        ),
        (ExceptionGroup("g", [ValueError("x")]), None),
        (MCPError(-32000, "x"), None),
    ],
)
def test_a_refused_reply_is_found_inside_any_exception_group(error, reason):
    assert refusal(error) == reason


@pytest.mark.asyncio
async def test_a_capped_stream_passes_a_body_of_exactly_its_cap():
    stream = CappedStream(
        httpx2.ByteStream(b"x" * 10), [10], httpx2.StreamError
    )
    assert b"".join([chunk async for chunk in stream]) == b"x" * 10


@pytest.mark.asyncio
async def test_a_capped_stream_refuses_the_first_byte_past_its_cap():
    stream = CappedStream(
        httpx2.ByteStream(b"x" * 11), [10], httpx2.StreamError
    )
    with pytest.raises(httpx2.StreamError, match=REPLY_TOO_LARGE):
        _ = [chunk async for chunk in stream]


@pytest.mark.asyncio
async def test_a_dropped_client_lets_its_calls_in_flight_run_on():
    async with kept(legacy=True) as (ws, fake):
        ws.create_session("other")
        line = asyncio.create_task(ws.shell("fx wait-forever"))
        for _ in range(500):
            if fake.started:
                break
            await asyncio.sleep(0.01)
        fake.down = True
        failed = await ws.shell("fx list-items", session_id="other")
        assert failed.exit_code == 1
        fake.down = False
        reopened = await ws.shell("fx list-items", session_id="other")
        assert reopened.exit_code == 0
        await asyncio.sleep(0.1)
        assert not line.done()
        assert "DELETE" not in [r["method"] for r in fake.requests]
        await ws.cancel()
        with pytest.raises(MirageAbortError):
            await line
        for _ in range(500):
            if "DELETE" in [r["method"] for r in fake.requests]:
                break
            await asyncio.sleep(0.01)
        assert [r["method"] for r in fake.requests].count("DELETE") == 1
    assert fake.opens() == 2


@pytest.mark.asyncio
async def test_removing_the_cli_closes_its_client():
    async with kept(legacy=True) as (ws, fake):
        assert (await ws.shell("fx list-items")).exit_code == 0
        assert "DELETE" not in [r["method"] for r in fake.requests]
        await ws.unregister_cli("fx")
        assert [r["method"] for r in fake.requests][-1] == "DELETE"


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_a_cancelled_call_leaves_the_client_open(legacy):
    async with kept(legacy=legacy) as (ws, fake):
        line = asyncio.create_task(ws.shell("fx wait-forever"))
        for _ in range(500):
            if fake.started:
                break
            await asyncio.sleep(0.01)
        await ws.cancel()
        with pytest.raises(MirageAbortError):
            await line
        assert (await ws.shell("fx list-items")).exit_code == 0
        for _ in range(500):
            if fake.cancelled:
                break
            await asyncio.sleep(0.01)
    assert fake.opens() == 1
    assert fake.cancelled == ["wait_forever"]


@pytest.mark.asyncio
async def test_a_network_policy_judges_each_call_on_its_own_client():
    async with kept(_Offline()) as (ws, fake):
        assert (await ws.shell("fx list-items")).exit_code == 0
        assert (await ws.shell("fx list-items")).exit_code == 0
        assert fake.opens() == 2
        fake.requests.clear()
        line = "echo offline >/dev/null; fx list-items"
        assert (await ws.shell(line)).exit_code == 1
    assert fake.requests == []


@pytest.mark.asyncio
async def test_a_session_held_to_another_rule_never_shares_the_client():
    async with kept() as (ws, fake):
        assert (await ws.shell("fx list-items")).exit_code == 0
        ws.create_session("closed", profile={"network": False})
        fake.requests.clear()
        result = await ws.shell("fx list-items", session_id="closed")
    assert result.exit_code == 1
    assert fake.requests == []
