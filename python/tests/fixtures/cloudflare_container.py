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
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestServer

from mirage.machine.constants import (
    CHECK_LINE,
    CHECK_MARK,
    EXEC_PRELUDE,
    is_run,
)

Program = Callable[["FakeProcess"], Awaitable[int]]

TOKEN = "relay-test-token"


def line_of(cmd: list[str]) -> str:
    """The line an exec runs: its argv past the prelude and a run's
    wrapper.

    Args:
        cmd (list[str]): what the exec was given.
    """
    inner = cmd[5:] if len(cmd) > 2 and cmd[2] == EXEC_PRELUDE else cmd
    if is_run(inner):
        inner = inner[7:]
    if inner[:2] == ["/bin/sh", "-c"]:
        return inner[2]
    return " ".join(inner)


class FakeInput:
    """A process's stdin, kept."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.closed = asyncio.Event()

    async def write(self, data: bytes) -> None:
        if self.closed.is_set():
            raise BrokenPipeError("input closed")
        self.data.extend(data)

    async def close(self) -> None:
        self.closed.set()


class FakeProcess:
    """A process a fake container's exec starts: ``program`` scripts it
    over real stream readers; a kill ends it with 128 plus the signal.

    Args:
        cmd (list[str]): what the exec was given.
        env (dict[str, str]): the exec's environment.
        program (Program): what the process does.
    """

    def __init__(
        self, cmd: list[str], env: dict[str, str], program: Program
    ) -> None:
        self.cmd = cmd
        self.env = env
        self.line = line_of(cmd)
        self.stdin = FakeInput()
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.exit_code: asyncio.Future[int] = (
            asyncio.get_running_loop().create_future()
        )
        self.killed: list[int] = []
        self.released = False
        self._signalled = asyncio.Event()
        self._task = asyncio.create_task(self._run(program))

    async def _run(self, program: Program) -> None:
        work = asyncio.create_task(program(self))
        signalled = asyncio.create_task(self._signalled.wait())
        done, _ = await asyncio.wait(
            {work, signalled}, return_when=asyncio.FIRST_COMPLETED
        )
        code = work.result() if work in done else 128 + self.killed[-1]
        for task in (work, signalled):
            task.cancel()
        await asyncio.gather(work, signalled, return_exceptions=True)
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.exit_code.set_result(code)

    async def kill(self, signum: int = 15) -> None:
        self.killed.append(signum)
        self._signalled.set()

    def release(self) -> None:
        self.released = True


async def check(proc: FakeProcess) -> int:
    proc.stdout.feed_data(f"{CHECK_MARK}\n".encode())
    return 0


async def nothing(proc: FakeProcess) -> int:
    return 0


class FakeContainer:
    """A container whose execs run programs by their first word.
    ``down`` refuses every exec; ``exit`` ends the container, which a
    waiting ``monitor`` hears.

    Args:
        programs (dict[str, Program] | None): programs by first word.
    """

    def __init__(self, programs: dict[str, Program] | None = None) -> None:
        self.programs = programs or {}
        self.procs: list[FakeProcess] = []
        self.down: Exception | None = None
        self.running = False
        self.starts = 0
        self._exited: asyncio.Future[None] | None = None

    def start(self) -> None:
        self.starts += 1
        self.running = True

    async def exec(self, cmd: list[str], env: dict[str, str]) -> FakeProcess:
        if self.down is not None:
            raise self.down
        line = line_of(cmd)
        program = (
            check
            if line == CHECK_LINE
            else self.programs.get(line.split(" ")[0], nothing)
        )
        proc = FakeProcess(cmd, env, program)
        self.procs.append(proc)
        return proc

    async def monitor(self) -> None:
        if self._exited is None or self._exited.done():
            self._exited = asyncio.get_running_loop().create_future()
        await self._exited

    def exit(self, error: Exception | None = None) -> None:
        self.running = False
        if self._exited is None or self._exited.done():
            return
        if error is None:
            self._exited.set_result(None)
        else:
            self._exited.set_exception(error)

    def ran(self, line: str) -> FakeProcess:
        return next(proc for proc in self.procs if proc.line == line)


async def _exec(
    ws: web.WebSocketResponse, box: FakeContainer, request: dict
) -> None:
    try:
        proc = await box.exec(list(request["argv"]), dict(request["env"]))
    except Exception as exc:
        await ws.send_json({"stopped": str(exc)})
        await ws.close()
        return
    exited = False
    await ws.send_json({"started": True})

    async def pump(
        reader: asyncio.StreamReader, channel: int, name: str
    ) -> None:
        while chunk := await reader.read(65536):
            await ws.send_bytes(bytes([channel]) + chunk)
        await ws.send_json({"closed": name})

    async def status() -> None:
        nonlocal exited
        code = await proc.exit_code
        exited = True
        await ws.send_json({"exit": code})

    tasks = [
        asyncio.create_task(pump(proc.stdout, 1, "stdout")),
        asyncio.create_task(pump(proc.stderr, 2, "stderr")),
        asyncio.create_task(status()),
    ]

    async def finish() -> None:
        await asyncio.gather(*tasks, return_exceptions=True)
        await ws.close()

    finishing = asyncio.create_task(finish())
    async for message in ws:
        if message.type is WSMsgType.BINARY:
            await proc.stdin.write(message.data)
        elif message.type is WSMsgType.TEXT:
            control = json.loads(message.data)
            if control.get("eof"):
                await proc.stdin.close()
            elif isinstance(control.get("kill"), int):
                await proc.kill(control["kill"])
    if not exited:
        await proc.kill(9)
    finishing.cancel()
    await asyncio.gather(finishing, return_exceptions=True)


def relay_app(box: FakeContainer) -> web.Application:
    """A relay over ``box`` that speaks ``ContainerRelay``'s protocol.

    Args:
        box (FakeContainer): the container it hands out.
    """

    async def handle(request: web.Request) -> web.StreamResponse:
        call = request.match_info["call"]
        if call == "start":
            if request.headers.get("Authorization") != f"Bearer {TOKEN}":
                return web.Response(
                    status=401, text="the relay refused the token\n"
                )
            if not box.running:
                box.start()
            return web.Response(status=204)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        first = await ws.receive()
        asked = json.loads(first.data)
        if asked.get("token") != TOKEN:
            await ws.send_json({"refused": "the relay refused the token"})
            await ws.close()
            return ws
        if call == "monitor":
            try:
                await box.monitor()
                await ws.send_json({"exited": None})
            except Exception as exc:
                await ws.send_json({"exited": str(exc)})
            await ws.close()
            return ws
        await _exec(ws, box, asked)
        return ws

    app = web.Application()
    app.router.add_route("*", "/relay/{name}/{call}", handle)
    return app


@asynccontextmanager
async def relay_server(box: FakeContainer) -> AsyncIterator[str]:
    """Serve a relay over ``box`` and yield the url that names it.

    Args:
        box (FakeContainer): the container it hands out.
    """
    server = TestServer(relay_app(box))
    await server.start_server()
    try:
        yield str(server.make_url("/relay/box"))
    finally:
        await server.close()
