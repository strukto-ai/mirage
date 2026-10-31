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
    network_route,
    network_routes,
    network_rule,
    run_with_network,
)
from mirage.policy.profile import SessionProfile
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
        ({"routes": {"a.com:80": "10.0.0.1:8080"}}, None),
        ({"allowed_domains": ["a.com"], "routes": {}}, {"allow": ["a.com"]}),
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
        {"routes": ["a.com:80"]},
        {"routes": {"a.com:80": 8080}},
    ],
)
def test_a_bad_setting_is_refused(setting):
    with pytest.raises(ValueError, match="network is true, false or"):
        network_layer(setting)


def test_a_bad_entry_is_refused():
    with pytest.raises(ValueError, match="is not an address, a range"):
        NetworkRule([{"allow": ["10.0.0.0/33"]}])


def test_a_route_sends_a_host_and_port_to_the_end_it_names():
    rule = NetworkRule(
        [],
        routes={
            "localhost:5003": "127.0.0.1:61001",
            "Svc.Test.:80": "[::1]:8080",
            "[::1]:22": "jump.test:2222",
        },
    )
    assert rule.route("localhost", 5003) == ("127.0.0.1", 61001)
    assert rule.route("LOCALHOST.", 5003) == ("127.0.0.1", 61001)
    assert rule.route("localhost", 5004) is None
    assert rule.route("svc.test", 80) == ("::1", 8080)
    assert rule.route("[::1]", 22) == ("jump.test", 2222)
    assert rule.route("::1", 22) == ("jump.test", 2222)


@pytest.mark.parametrize(
    ("routes", "message"),
    [
        ({"localhost": "127.0.0.1:1"}, 'route "localhost" is not host:port'),
        (
            {"localhost:5003": "127.0.0.1"},
            'route "127.0.0.1" is not host:port',
        ),
        ({"localhost:0": "127.0.0.1:1"}, "is not host:port"),
        ({"localhost:65536": "127.0.0.1:1"}, "is not host:port"),
        ({"::1:80": "127.0.0.1:1"}, "is not host:port"),
        (
            {"a.test:80": "b.test:80", "B.test:80": "c.test:80"},
            "goes to b.test:80, which is routed too",
        ),
    ],
)
def test_a_bad_route_is_refused(routes, message):
    with pytest.raises(ValueError, match=message):
        NetworkRule([], routes=routes)


@pytest.mark.asyncio
async def test_routes_alone_build_a_rule_the_bound_call_answers_by():
    setting = {"routes": {"localhost:5003": "127.0.0.1:61001"}}
    assert network_routes(setting) == setting["routes"]
    assert network_routes(False) == {}
    rule = network_rule(setting)
    assert rule is not None and rule.layers == ()
    assert network_rule({"routes": {}}) is None
    assert network_route("localhost", 5003) is None

    async def ask() -> tuple[str, int] | None:
        return network_route("localhost", 5003)

    assert await run_with_network(rule, ask()) == ("127.0.0.1", 61001)


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


async def _fetched(network, url: str) -> int:
    ws = Workspace({"/data": RAMVFS()}, network=network)
    try:
        return (await ws.shell(f"curl -sS {url}")).exit_code
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_routed_connection_goes_where_its_route_names(port):
    to = f"127.0.0.1:{port}"
    routes = {"routes": {"svc.test:5003": to}}
    assert await _fetched(routes, "http://svc.test:5003/") == 0
    spelled = {"routes": {"SVC.test.:5003": to}}
    assert await _fetched(spelled, "http://svc.test:5003/") == 0
    held = {"allowed_domains": [to], "routes": {"localhost:5003": to}}
    assert await _fetched(held, "http://localhost:5003/") == 0
    assert await _fetched(held, "http://localhost:5004/") == 7
    assert await _fetched(held, f"http://127.0.0.1:{port + 1}/") == 7
    target = {
        "allowed_domains": ["localhost"],
        "routes": {"localhost:5003": to},
    }
    assert await _fetched(target, "http://localhost:5003/") == 7


@pytest.mark.asyncio
async def test_each_workspace_sends_the_same_address_to_its_own_end(port):
    async def other_answer(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        await reader.read(1024)
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n"
            b"Connection: close\r\n\r\nother\n"
        )
        await writer.drain()
        writer.close()

    other = await asyncio.start_server(other_answer, "127.0.0.1", 0)
    at = other.sockets[0].getsockname()[1]
    t1 = Workspace(
        {"/data": RAMVFS()},
        network={"routes": {"localhost:5003": f"127.0.0.1:{port}"}},
    )
    t2 = Workspace(
        {"/data": RAMVFS()},
        network={"routes": {"localhost:5003": f"127.0.0.1:{at}"}},
    )

    async def read(ws: Workspace) -> str:
        io = await ws.shell("curl -sS http://localhost:5003/")
        return await io.stdout_str()

    try:
        assert await asyncio.gather(read(t1), read(t2), read(t1)) == [
            "ok\n",
            "other\n",
            "ok\n",
        ]
    finally:
        await t1.close()
        await t2.close()
        other.close()
        await other.wait_closed()


@pytest.mark.asyncio
async def test_a_profile_routes_its_sessions_over_the_workspace(port):
    ws = Workspace(
        {"/data": RAMVFS()},
        network={"routes": {"svc.test:5003": "127.0.0.1:1"}},
        profiles={
            "agent": {
                "network": {"routes": {"svc.test:5003": f"127.0.0.1:{port}"}}
            },
        },
    )
    ws.create_session("a", profile="agent")
    line = "curl -sS http://svc.test:5003/"
    try:
        assert (await ws.shell(line, session_id="a")).exit_code == 0
        assert (await ws.shell(line)).exit_code == 7
    finally:
        await ws.close()


def test_names_sharing_an_address_keep_their_own_ports():
    rule = NetworkRule([{"allow": ["a.test:443", "b.test:8443"]}])
    assert rule.resolved("a.test", "10.1.1.1", 443)
    assert rule.resolved("b.test", "10.1.1.1", 8443)
    assert rule.connects("10.1.1.1", 443)
    assert rule.connects("10.1.1.1", 8443)
    assert not rule.connects("10.1.1.1", 22)


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
