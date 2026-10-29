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
from mirage.vfs.ram import RAMVFS


@pytest.mark.parametrize(
    ("setting", "layer"),
    [
        (True, None),
        (False, {"allow": []}),
        ({"allow": ["a.com"]}, {"allow": ["a.com"]}),
    ],
)
def test_a_setting_adds_its_layer(setting, layer):
    assert network_layer(setting) == layer


@pytest.mark.parametrize(
    "setting", ["off", {"deny": ["a.com"]}, {"allow": "a.com"}]
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
        ({"allow": ["127.0.0.0/8"]}, 0),
        (False, 7),
        ({"allow": ["example.com"]}, 7),
    ],
)
async def test_curl_clears_the_workspace_rule(port, network, exit_code):
    assert await _curl(port, network) == exit_code


@pytest.mark.asyncio
async def test_a_name_is_judged_by_the_host_it_was_asked_for(port):
    assert await _curl(port, {"allow": ["localhost"]}, "localhost") == 0
    assert await _curl(port, {"allow": ["example.com"]}, "localhost") == 7


@pytest.mark.asyncio
async def test_a_name_lends_its_address_to_no_other_name(port, monkeypatch):
    resolve = network._resolve

    def local(host, *args, **kwargs):
        name = host.decode() if isinstance(host, bytes) else host
        named = name in ("allowed.test", "other.test")
        return resolve("127.0.0.1" if named else host, *args, **kwargs)

    monkeypatch.setattr(network, "_resolve", local)
    held = Workspace({"/data": RAMVFS()}, network={"allow": ["allowed.test"]})
    other = Workspace({"/data": RAMVFS()}, network={"allow": ["other.test"]})
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
