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

import pytest
import pytest_asyncio

from mirage import Workspace
from mirage.io import network
from mirage.io.network import (
    NetworkRule,
    network_bound,
    network_layer,
    network_lets,
    run_with_network,
)
from mirage.policy import (
    Deny,
    NetworkContext,
    NetworkResultContext,
    Policy,
)
from mirage.policy.profile import SessionProfile
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS


@pytest.mark.parametrize(
    ("setting", "layer"),
    [
        (True, None),
        (False, {"allow": []}),
        ({"allowed_domains": ["a.com"]}, {"allow": ["a.com"]}),
        ({"denied_domains": ["*:22"]}, {"deny": ["*:22"]}),
        (
            {"allowed_domains": ["*"], "denied_domains": ["evil.test"]},
            {"allow": ["*"], "deny": ["evil.test"]},
        ),
    ],
)
def test_a_setting_adds_its_layer(setting, layer):
    assert network_layer(setting) == layer


@pytest.mark.parametrize(
    "setting",
    [
        "off",
        {},
        {"allow": ["a.com"]},
        {"deny": ["a.com"]},
        {"allowed_domains": "a.com"},
    ],
)
def test_a_bad_setting_is_refused(setting):
    with pytest.raises(ValueError, match="network is true, false or"):
        network_layer(setting)


def test_a_bad_entry_is_refused():
    with pytest.raises(ValueError, match="is not an address, a range"):
        NetworkRule([{"allow": ["10.0.0.0/33"]}])


@pytest.mark.asyncio
async def test_a_rule_holds_only_the_call_it_is_bound_to():
    rule = NetworkRule([{"allow": ["*.github.com"]}])

    async def ask() -> tuple[bool, bool]:
        assert network_bound() is rule
        return (
            network_lets("api.github.com", "140.82.112.6"),
            network_lets("", "127.0.0.1"),
        )

    assert await run_with_network(rule, ask()) == (True, False)
    assert network_bound() is None
    assert network_lets("", "127.0.0.1")


async def _answer(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    await reader.read(1024)
    writer.write(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n"
        b"Connection: close\r\n\r\nok\n"
    )
    await writer.drain()
    writer.close()


@pytest_asyncio.fixture
async def port():
    server = await asyncio.start_server(_answer, "127.0.0.1", 0)
    yield server.sockets[0].getsockname()[1]
    server.close()
    await server.wait_closed()


async def _curl(port: int, network, host: str = "127.0.0.1") -> int:
    ws = Workspace({"/data": RAMVFS()}, network=network)
    try:
        result = await ws.shell(f"curl -sS http://{host}:{port}/")
        return result.exit_code
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("network", "exit_code"),
    [
        (True, 0),
        ({"allowed_domains": ["127.0.0.0/8"]}, 0),
        (False, 7),
        ({"allowed_domains": ["example.com"]}, 7),
        ({"denied_domains": ["127.0.0.0/8"]}, 7),
        ({"allowed_domains": ["*"], "denied_domains": ["127.0.0.1"]}, 7),
    ],
)
async def test_curl_clears_the_workspace_rule(port, network, exit_code):
    assert await _curl(port, network) == exit_code


@pytest.mark.asyncio
async def test_an_entry_can_hold_a_connection_to_one_port(port):
    assert await _curl(port, {"allowed_domains": [f"127.0.0.1:{port}"]}) == 0
    assert await _curl(port, {"allowed_domains": ["127.0.0.1:1"]}) == 7
    assert await _curl(port, {"denied_domains": [f"*:{port}"]}) == 7
    named = {"allowed_domains": [f"localhost:{port}"]}
    assert await _curl(port, named, "localhost") == 0
    named = {"allowed_domains": ["localhost:1"]}
    assert await _curl(port, named, "localhost") == 7


@pytest.mark.asyncio
async def test_a_name_is_judged_by_the_host_it_was_asked_for(port):
    allowed = {"allowed_domains": ["localhost"]}
    assert await _curl(port, allowed, "localhost") == 0
    other = {"allowed_domains": ["example.com"]}
    assert await _curl(port, other, "localhost") == 7


@pytest.mark.asyncio
async def test_a_name_lends_its_address_to_no_other_name(port, monkeypatch):
    resolve = network._resolve

    def local(host, *args, **kwargs):
        name = host.decode() if isinstance(host, bytes) else host
        named = name in ("allowed.test", "other.test")
        return resolve("127.0.0.1" if named else host, *args, **kwargs)

    monkeypatch.setattr(network, "_resolve", local)
    held = Workspace(
        {"/data": RAMVFS()}, network={"allowed_domains": ["allowed.test"]}
    )
    other = Workspace(
        {"/data": RAMVFS()}, network={"allowed_domains": ["other.test"]}
    )
    try:
        for ws, host, exit_code in [
            (held, "allowed.test", 0),
            (held, "other.test", 7),
            (other, "127.0.0.1", 7),
            (other, "other.test", 0),
        ]:
            line = f"curl -sS http://{host}:{port}/"
            assert (await ws.shell(line)).exit_code == exit_code, host
    finally:
        await held.close()
        await other.close()


class _Watch(Policy):
    """Refuses the hosts it is given, counts what is in flight, keeps
    what each method saw."""

    def __init__(self, refused: tuple[str, ...] = ()) -> None:
        self.refused = refused
        self.open = 0
        self.most = 0
        self.asked: list[NetworkContext] = []
        self.ended: list[NetworkResultContext] = []

    async def pre_network(self, ctx: NetworkContext) -> Deny | None:
        self.asked.append(ctx)
        if ctx.host in self.refused:
            return Deny(f"{ctx.host} is not for this tenant")
        self.open += 1
        self.most = max(self.most, self.open)
        return None

    async def post_network(self, ctx: NetworkResultContext) -> None:
        self.ended.append(ctx)
        self.open -= 1
        return None


async def _watched(watch: _Watch, line: str) -> int:
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)})
    ws.policies.add(watch)
    try:
        return (await ws.shell(line)).exit_code
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_pre_network_refuses_a_request_as_a_closed_port(port):
    watch = _Watch(refused=("127.0.0.1",))
    assert await _watched(watch, f"curl -sS http://127.0.0.1:{port}/") == 7
    assert await _watched(watch, f"wget -q -O - http://127.0.0.1:{port}/") == 4
    asked = watch.asked[0]
    assert (asked.url, asked.method, asked.host, asked.port) == (
        f"http://127.0.0.1:{port}/",
        "GET",
        "127.0.0.1",
        port,
    )
    assert [ctx.command for ctx in watch.asked] == ["curl", "wget"]
    assert watch.ended == []


@pytest.mark.asyncio
async def test_post_network_sees_how_each_request_ended(port):
    watch = _Watch()
    line = (
        f"curl -sS http://127.0.0.1:{port}/ > /data/a; "
        f"curl -sS -o /data/b http://127.0.0.1:{port}/; "
        f"curl -sS -o /missing/c http://127.0.0.1:{port}/"
    )
    assert await _watched(watch, line) == 23
    assert [(e.status, e.size, e.failed) for e in watch.ended] == [
        (200, 3, False),
        (200, 3, False),
        (200, 3, True),
    ]
    assert (watch.open, watch.most) == (0, 1)


@pytest.mark.asyncio
async def test_post_network_sees_a_refused_connection_fail(port):
    watch = _Watch()
    ws = Workspace({"/data": RAMVFS()}, network=False)
    ws.policies.add(watch)
    try:
        line = f"curl -sS http://127.0.0.1:{port}/"
        assert (await ws.shell(line)).exit_code == 7
    finally:
        await ws.close()
    assert [(e.status, e.failed) for e in watch.ended] == [(0, True)]


@pytest.mark.asyncio
async def test_a_profile_narrows_its_sessions_network(port):
    ws = Workspace(
        {"/data": RAMVFS()},
        network={"denied_domains": ["10.0.0.0/8"]},
        profiles={
            "agent": {"network": {"allowed_domains": [f"127.0.0.1:{port}"]}},
            "review": {"network": False},
            "wide": {"network": True},
        },
    )
    ws.create_session("a", profile="agent")
    ws.create_session("r", profile="review")
    ws.create_session("w", profile="wide")
    line = f"curl -sS http://127.0.0.1:{port}/"
    try:
        for session_id, exit_code in [("a", 0), ("r", 7), ("w", 0)]:
            io = await ws.shell(line, session_id=session_id)
            assert io.exit_code == exit_code, session_id
        assert ws.registry.network_of(
            {"allowed_domains": [f"127.0.0.1:{port}"]}
        ) is ws.registry.network_of({"allowed_domains": [f"127.0.0.1:{port}"]})
        assert ws.registry.network_of(None) is ws.registry.network
    finally:
        await ws.close()


def test_a_profile_network_must_be_a_setting():
    with pytest.raises(ValueError, match="network is true, false or"):
        SessionProfile(network={"allow": ["a.com"]})
    with pytest.raises(ValueError, match="is not an address, a range"):
        SessionProfile(network={"denied_domains": ["10.0.0.0/33"]})
