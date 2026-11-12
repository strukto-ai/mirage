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

from mirage.machine.cloudflare_container import (
    ContainerMachine,
    RelayContainer,
)
from mirage.machine.cloudflare_container.constants import RELAY_WINDOW_BYTES
from mirage.machine.cloudflare_container.relay import frame_of
from tests.fixtures.cloudflare_container import (
    TOKEN,
    FakeContainer,
    FakeProcess,
    relay_server,
)

ODD = bytes([0, 13, 10, 255, 128, 254, 0])


async def cat(proc: FakeProcess) -> int:
    await proc.stdin.closed.wait()
    proc.stdout.feed_data(bytes(proc.stdin.data))
    proc.stderr.feed_data(ODD)
    return 3


async def sleep(proc: FakeProcess) -> int:
    await asyncio.Event().wait()
    return 0


CHUNK = 65536
WRITTEN: list[int] = []


async def flood(proc: FakeProcess) -> int:
    for _ in range(4 * RELAY_WINDOW_BYTES // CHUNK):
        proc.stdout.feed_data(b"x" * CHUNK)
        WRITTEN.append(CHUNK)
        while len(proc.stdout._buffer) > CHUNK:
            await asyncio.sleep(0.001)
    return 0


def test_a_frame_is_an_object_or_nothing():
    assert frame_of('{"exit": 3}') == {"exit": 3}
    assert frame_of("[1]") is None
    assert frame_of("not json") is None


@pytest.mark.asyncio
async def test_starts_the_container_once_and_refuses_a_wrong_token():
    box = FakeContainer()
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        await relay.start()
        await relay.start()
        wrong = RelayContainer(url, "wrong")
        with pytest.raises(
            RuntimeError, match="answered 401 to start: the relay"
        ):
            await wrong.start()
        with pytest.raises(ConnectionResetError, match="refused the token"):
            await wrong.exec(["true"], {})
        await relay.close()
        await wrong.close()
    assert box.starts == 1


@pytest.mark.asyncio
async def test_carries_argv_env_stdin_and_both_outputs_then_the_status():
    box = FakeContainer({"cat": cat})
    box.start()
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        proc = await relay.exec(["cat", "-"], {"K": "v"})
        await proc.stdin.write(ODD)
        await proc.stdin.write(b"tail")
        await proc.stdin.close()
        out, err, code = await asyncio.wait_for(
            asyncio.gather(
                proc.stdout.read(), proc.stderr.read(), proc.exit_code
            ),
            5,
        )
        await relay.close()
    assert (out, err, code) == (ODD + b"tail", ODD, 3)
    assert (box.procs[0].cmd, box.procs[0].env) == (["cat", "-"], {"K": "v"})


@pytest.mark.asyncio
async def test_forwards_a_signal_and_kills_a_process_its_client_left():
    box = FakeContainer({"sleep": sleep})
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        signalled = await relay.exec(["sleep"], {})
        await signalled.kill(2)
        assert await asyncio.wait_for(signalled.exit_code, 5) == 130
        left = await relay.exec(["sleep"], {})
        await relay.close()
        with pytest.raises(ConnectionResetError):
            await asyncio.wait_for(left.exit_code, 5)

        async def killed() -> None:
            while not box.procs[1].killed:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(killed(), 5)
    assert (box.procs[0].killed, box.procs[1].killed) == ([2], [9])


@pytest.mark.asyncio
async def test_an_exec_on_a_stopped_container_fails_with_what_it_said():
    box = FakeContainer()
    box.down = RuntimeError(
        "exec() cannot be called on a container that is not running."
    )
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        with pytest.raises(ConnectionResetError, match="not running"):
            await relay.exec(["true"], {})
        await relay.close()


@pytest.mark.asyncio
async def test_a_monitor_hears_the_container_exit_with_its_error():
    box = FakeContainer()
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        clean = asyncio.create_task(relay.monitor())
        await asyncio.sleep(0.1)
        box.exit()
        await asyncio.wait_for(clean, 5)
        failed = asyncio.create_task(relay.monitor())
        await asyncio.sleep(0.1)
        box.exit(RuntimeError("out of memory"))
        with pytest.raises(RuntimeError, match="out of memory"):
            await asyncio.wait_for(failed, 5)
        await relay.close()


@pytest.mark.asyncio
async def test_a_machine_built_from_a_url_runs_lines_through_the_relay():
    box = FakeContainer({"cat": cat})
    async with relay_server(box) as url:
        machine = ContainerMachine("box", {"url": url, "token": TOKEN})
        await machine._ensure_connected()
        result = await asyncio.wait_for(
            machine.exec_line("cat", b"via the relay", {}, "/"), 5
        )
        await machine.close()
    assert (result.exit_code, result.stdout, result.stderr) == (
        3,
        b"via the relay",
        ODD,
    )
    assert box.starts == 1


@pytest.mark.asyncio
async def test_output_waits_for_a_reader_that_falls_behind():
    WRITTEN.clear()
    box = FakeContainer({"flood": flood})
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        proc = await relay.exec(["flood"], {})
        await proc.stdin.close()
        await asyncio.sleep(0.5)
        held = sum(WRITTEN)
        assert held <= 2 * RELAY_WINDOW_BYTES
        out = await asyncio.wait_for(proc.stdout.read(), 10)
        assert await asyncio.wait_for(proc.exit_code, 5) == 0
        await relay.close()
    assert len(out) == 4 * RELAY_WINDOW_BYTES


async def burst(proc: FakeProcess) -> int:
    for _ in range(4 * RELAY_WINDOW_BYTES // CHUNK):
        proc.stdout.feed_data(b"x" * CHUNK)
        while len(proc.stdout._buffer) > CHUNK:
            await asyncio.sleep(0.001)
    return 0


@pytest.mark.asyncio
async def test_an_exact_read_past_the_window_completes():
    box = FakeContainer({"burst": burst})
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        proc = await relay.exec(["burst"], {})
        await proc.stdin.close()
        whole = await asyncio.wait_for(
            proc.stdout.readexactly(2 * RELAY_WINDOW_BYTES), 10
        )
        proc.release()
        assert await asyncio.wait_for(proc.exit_code, 10) == 0
        await relay.close()
    assert len(whole) == 2 * RELAY_WINDOW_BYTES


async def deaf(proc: FakeProcess) -> int:
    await proc.stdin.close()
    await asyncio.Event().wait()
    return 0


@pytest.mark.asyncio
async def test_a_write_after_the_program_closed_its_input_fails():
    box = FakeContainer({"deaf": deaf})
    async with relay_server(box) as url:
        relay = RelayContainer(url, TOKEN)
        proc = await relay.exec(["deaf"], {})
        chunk = b"x" * (RELAY_WINDOW_BYTES // 4)

        async def flood() -> None:
            for _ in range(16):
                await proc.stdin.write(chunk)

        with pytest.raises(BrokenPipeError, match="closed its input"):
            await asyncio.wait_for(flood(), 5)
        await proc.kill(9)
        await asyncio.wait_for(proc.exit_code, 5)
        await relay.close()
