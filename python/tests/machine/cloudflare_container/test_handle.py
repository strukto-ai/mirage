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

from mirage.commands.config import Context
from mirage.machine.cloudflare_container import ContainerMachine
from mirage.machine.cloudflare_container.constants import (
    BOTH,
    NO_CONTAINER,
    SLEEP_RELAY,
    STOPPED,
)
from mirage.machine.constants import CHECK_LINE, EXEC_PRELUDE, PROCESS
from mirage.machine.mixin import SleepableMixin
from mirage.machine.registry import build_machine
from mirage.types import PathSpec
from tests.fixtures.cloudflare_container import FakeContainer, FakeProcess
from tests.fixtures.machine import machine_runtime

ODD = bytes([0, 13, 10, 255, 128, 254, 0])
LOST = (
    f"cloudflare_container: {STOPPED}\n"
    "mirage: cloudflare_container:box: connection lost\n"
).encode()


def _line(box: ContainerMachine, line: str, stdin: bytes | None = None):
    cwd = PathSpec.from_str_path("/data")
    ctx = Context(flags={"c": line}, stdin=stdin, env=None, cwd=cwd)
    return machine_runtime(box).run_line(None, [], [], ctx)


async def cat(proc: FakeProcess) -> int:
    await proc.stdin.closed.wait()
    proc.stdout.feed_data(bytes(proc.stdin.data))
    proc.stderr.feed_data(ODD)
    return 3


async def sleep(proc: FakeProcess) -> int:
    await asyncio.Event().wait()
    return 0


async def echo(proc: FakeProcess) -> int:
    await proc.stdin.closed.wait()
    proc.stdout.feed_data(bytes(proc.stdin.data))
    await asyncio.Event().wait()
    return 0


async def lost(proc: FakeProcess) -> int:
    raise ConnectionResetError("the connection to the relay closed")


async def over_quota() -> None:
    raise RuntimeError("monthly container time is used up")


def boxed(**programs) -> tuple[FakeContainer, ContainerMachine]:
    box = FakeContainer(programs)

    async def start() -> None:
        box.start()

    return box, ContainerMachine("box", {}, box, start)


@pytest.mark.asyncio
async def test_runs_a_line_under_the_prelude_with_the_cwd_as_its_first_argument():
    box, machine = boxed()
    result = await machine.exec_line("echo hi", None, {"A": "1"}, "/data")
    assert result.exit_code == 0
    proc = box.ran("echo hi")
    assert proc.cmd[:5] == ["/bin/sh", "-c", EXEC_PRELUDE, "sh", "/data"]
    assert proc.cmd[5:] == ["/bin/sh", "-c", "echo hi"]
    assert proc.env["A"] == "1" and PROCESS in proc.env


@pytest.mark.asyncio
async def test_pipes_stdin_and_carries_both_outputs_byte_for_byte():
    box, machine = boxed(cat=cat)
    result = await asyncio.wait_for(_line(machine, "cat", ODD), 5)
    assert (result.exit_code, result.stdout, result.stderr) == (3, ODD, ODD)
    assert box.ran("cat").stdin.closed.is_set()
    assert box.starts == 1
    assert box.procs[0].line == CHECK_LINE


@pytest.mark.asyncio
async def test_a_refused_exec_loses_the_connection_and_the_next_line_starts_again():
    box, machine = boxed(cat=cat)
    assert (await _line(machine, "cat", b"x")).exit_code == 3
    box.down = RuntimeError(
        "exec() cannot be called on a container that is not running."
    )
    result = await asyncio.wait_for(_line(machine, "cat", b"x"), 5)
    assert (result.exit_code, result.stderr) == (129, LOST)
    box.down = None
    assert (await _line(machine, "cat", b"x")).exit_code == 3
    assert box.starts == 2


@pytest.mark.asyncio
async def test_a_status_lost_after_the_output_ended_loses_the_connection():
    box, machine = boxed(lost=lost, cat=cat)
    result = await asyncio.wait_for(_line(machine, "lost"), 5)
    assert (result.exit_code, result.stderr) == (129, LOST)
    assert (await _line(machine, "cat", b"x")).exit_code == 3
    assert box.starts == 2


@pytest.mark.asyncio
async def test_a_container_that_exits_under_a_line_cuts_it_short():
    box, machine = boxed(sleep=sleep)
    running = asyncio.create_task(_line(machine, "sleep"))
    while not any(proc.line == "sleep" for proc in box.procs):
        await asyncio.sleep(0.01)
    box.exit()
    result = await asyncio.wait_for(running, 5)
    assert (result.exit_code, result.stderr) == (129, LOST)
    assert box.ran("sleep").released


@pytest.mark.asyncio
async def test_a_cancelled_line_kills_its_process():
    box, machine = boxed(sleep=sleep)
    await machine._ensure_connected()
    running = asyncio.create_task(machine.exec_line("sleep", None, {}, "/"))
    while not any(proc.line == "sleep" for proc in box.procs):
        await asyncio.sleep(0.01)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert box.ran("sleep").killed == [9]


@pytest.mark.asyncio
async def test_fails_a_line_with_the_error_start_raised():
    box = FakeContainer()
    machine = ContainerMachine("box", {}, box, over_quota)
    with pytest.raises(RuntimeError, match="monthly container time"):
        await machine._ensure_connected()
    assert box.procs == []


@pytest.mark.asyncio
async def test_without_a_container_or_a_relay_connecting_says_how_to_reach_one():
    machine = build_machine("box", {"provider": "cloudflare_container"})
    with pytest.raises(RuntimeError, match="set url and token"):
        await machine._ensure_connected()
    assert NO_CONTAINER.startswith("cloudflare_container needs the container")


def test_a_relay_url_needs_a_token_and_no_container():
    url = "https://relay.example.workers.dev/box"
    built = build_machine(
        "box", {"provider": "cloudflare_container", "url": url, "token": "t"}
    )
    assert isinstance(built, ContainerMachine)
    with pytest.raises(ValueError, match="nonblank token"):
        build_machine("box", {"provider": "cloudflare_container", "url": url})
    with pytest.raises(ValueError, match=BOTH):
        ContainerMachine("box", {"url": url, "token": "t"}, FakeContainer())


def test_takes_no_image_instance_or_network():
    with pytest.raises(Exception, match="image"):
        build_machine(
            "box", {"provider": "cloudflare_container", "image": "x"}
        )


@pytest.mark.asyncio
async def test_a_pipe_sends_its_writes_in_order_and_stops_with_term():
    box, machine = boxed(sftp=echo)
    pipe = await machine.open_pipe("sftp -e")
    pipe.writer.write(b"a")
    pipe.writer.write(b"b")
    pipe.writer.close()
    assert await asyncio.wait_for(pipe.reader.readexactly(2), 5) == b"ab"
    await pipe.stop()
    assert box.ran("sftp -e").killed == [15]


async def _nothing() -> None:
    return None


@pytest.mark.asyncio
async def test_sleep_runs_the_hosts_hook_once_after_close():
    order: list[str] = []

    async def sleep() -> None:
        order.append("sleep")

    machine = ContainerMachine("box", {}, FakeContainer(), _nothing, sleep)
    assert isinstance(machine, SleepableMixin)
    await machine.close()
    order.append("closed")
    await machine.sleep()
    assert order == ["closed", "sleep"]


@pytest.mark.asyncio
async def test_sleep_does_nothing_without_a_hook():
    _, machine = boxed()
    await machine.sleep()


def test_a_relays_container_takes_no_sleep_hook():
    url = "https://relay.example.workers.dev/box"
    with pytest.raises(ValueError, match=SLEEP_RELAY):
        ContainerMachine(
            "box", {"url": url, "token": "t"}, None, None, _nothing
        )
