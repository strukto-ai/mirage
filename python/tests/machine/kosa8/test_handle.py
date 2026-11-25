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
import base64
import json
import logging
import os
import re
import signal
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.config import Context
from mirage.context.session_context import run_as_process
from mirage.execution.process.table import ProcessTable
from mirage.machine.constants import PROCESS, stop_line
from mirage.machine.errors import ConnectionLostError
from mirage.machine.kosa8 import Kosa8Machine
from mirage.machine.kosa8.api import Kosa8Api
from mirage.machine.kosa8.constants import PRELUDE
from mirage.machine.registry import build_machine
from mirage.types import PathSpec
from tests.fixtures.machine import machine_answer

logger = logging.getLogger(__name__)

SANDBOX = re.compile(r"^/v1/sandboxes/([^/]+)(/.*)?$")


class FakeKosa8:
    """kosa8 Cloud's REST API over local processes: each exec runs its
    argv under ``/bin/sh`` here, streaming NDJSON frames, and like kosa8
    keeps running when its stream is dropped; files land at their paths.

    Args:
        home (Path): the HOME the sandbox's commands see.
    """

    def __init__(self, home: Path) -> None:
        self.home = home
        self.sandboxes: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []
        self.created: list[dict] = []
        self.egress: dict[str, dict] = {}
        self.execs: list[list[str]] = []
        self.uploads: list[str] = []
        self.procs: list[asyncio.subprocess.Process] = []
        self.create_state = "running"
        self.later_state = "running"
        self.cut_after: int | None = None
        self.exec_status: int | None = None

    def add(self, state: str = "running") -> str:
        sandbox_id = f"sbx_{len(self.sandboxes) + 1}"
        self.sandboxes[sandbox_id] = {"id": sandbox_id, "state": state}
        return sandbox_id

    def api(self, key: str | None = "k8c_live_test") -> Kosa8Api:
        return Kosa8Api(key, None, transport=httpx.MockTransport(self.handle))

    async def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if path == "/v1/sandboxes" and request.method == "POST":
            body = json.loads(request.content)
            self.created.append(body)
            sandbox_id = self.add(self.create_state)
            self.sandboxes[sandbox_id]["state"] = self.later_state
            return httpx.Response(
                201,
                json={
                    "sandbox": {"id": sandbox_id, "state": self.create_state}
                },
            )
        found = SANDBOX.match(path)
        assert found is not None, path
        sandbox_id, rest = found.group(1), found.group(2) or ""
        sandbox = self.sandboxes.get(sandbox_id)
        if sandbox is None or sandbox["state"] == "deleted":
            return httpx.Response(
                404, json={"error": "not_found", "message": "no such sandbox"}
            )
        if rest == "" and request.method == "GET":
            return httpx.Response(200, json={"sandbox": dict(sandbox)})
        if rest == "" and request.method == "DELETE":
            sandbox["state"] = "deleted"
            return httpx.Response(200, json={})
        if rest == "/sleep":
            sandbox["state"] = "sleeping"
            return httpx.Response(200, json={"sandbox": dict(sandbox)})
        if rest == "/egress":
            self.egress[sandbox_id] = json.loads(request.content)
            return httpx.Response(200, json={"egress": {}})
        if rest == "/files/raw":
            target = Path(request.url.params["path"])
            target.write_bytes(await request.aread())
            self.uploads.append(str(target))
            return httpx.Response(200, json={"file": {}})
        if rest == "/files" and request.method == "DELETE":
            Path(request.url.params["path"]).unlink(missing_ok=True)
            return httpx.Response(200, json={})
        if rest == "/exec":
            if self.exec_status is not None:
                return httpx.Response(
                    self.exec_status,
                    json={
                        "error": "host_failed",
                        "message": "the host failed",
                    },
                )
            sandbox["state"] = "running"
            argv = json.loads(request.content)["cmd"]
            self.execs.append(argv)
            return httpx.Response(200, content=self._frames(argv))
        raise AssertionError(f"unexpected {request.method} {path}")

    async def _frames(self, argv: list[str]) -> AsyncIterator[bytes]:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
            env={"PATH": os.environ["PATH"], "HOME": str(self.home)},
            cwd="/",
        )
        self.procs.append(proc)
        queue: asyncio.Queue = asyncio.Queue()

        async def pump(reader, name):
            while data := await reader.read(65536):
                await queue.put((name, data))
            await queue.put(None)

        pumps = [
            asyncio.create_task(pump(proc.stdout, "stdout")),
            asyncio.create_task(pump(proc.stderr, "stderr")),
        ]
        sent = 0
        ended = 0
        while ended < 2:
            item = await queue.get()
            if item is None:
                ended += 1
                continue
            if self.cut_after is not None and sent >= self.cut_after:
                return
            sent += 1
            name, data = item
            yield (
                json.dumps(
                    {"stream": name, "data": base64.b64encode(data).decode()}
                ).encode()
                + b"\n"
            )
        await asyncio.gather(*pumps)
        yield (
            json.dumps({"done": True, "exit": await proc.wait()}).encode()
            + b"\n"
        )

    async def stop_all(self) -> None:
        for proc in self.procs:
            if proc.returncode is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (PermissionError, ProcessLookupError) as exc:
                    logger.debug("the fake command had already ended: %s", exc)
                await proc.wait()


class Memory:
    workspace_id = "ws-1"

    def __init__(
        self, kept: dict[str, str] | None = None, fail: bool = False
    ) -> None:
        self.kept = dict(kept or {})
        self.fail = fail

    async def recall(self, name):
        return self.kept.get(name)

    async def remember(self, name, instance):
        if self.fail:
            raise OSError("the workspace store is down")
        self.kept[name] = instance

    async def forget(self, name):
        self.kept.pop(name, None)

    async def remembered(self):
        return dict(self.kept)


@pytest_asyncio.fixture
async def fake(tmp_path, monkeypatch):
    server = FakeKosa8(tmp_path)
    monkeypatch.setattr(Kosa8Machine, "_new_api", lambda self: server.api())
    yield server
    await server.stop_all()


def _machine(**config) -> Kosa8Machine:
    return Kosa8Machine("box", config=config)


async def _brought(fake, **config) -> Kosa8Machine:
    machine = _machine(sandbox_id=fake.add(), **config)
    await machine.ensure_connected()
    return machine


@pytest.mark.asyncio
async def test_a_brought_sandbox_is_reached_by_id(fake):
    machine = await _brought(fake)
    assert machine.instance == "sbx_1"
    assert fake.calls == [("GET", "/v1/sandboxes/sbx_1")]
    assert not machine.started_by_mirage


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["sleeping", "creating"])
async def test_a_sleeping_sandbox_is_left_to_wake_on_the_line(fake, state):
    machine = _machine(sandbox_id=fake.add(state))
    await machine.ensure_connected()
    result = await machine.exec_line("echo up", None, {}, "/")
    assert result.stdout == b"up\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state,hint",
    [
        ("deleted", "was deleted or never existed"),
        ("error", "failed to start"),
        ("stopped", "was stopped"),
    ],
)
async def test_a_brought_sandbox_that_is_gone_says_what_to_do(
    fake, state, hint
):
    machine = _machine(sandbox_id=fake.add(state))
    with pytest.raises(
        RuntimeError, match=f"sandbox sbx_1 is not running: it {hint}"
    ):
        await machine.ensure_connected()


@pytest.mark.asyncio
async def test_an_unknown_sandbox_says_what_to_do(fake):
    with pytest.raises(RuntimeError, match="deleted or never existed"):
        await _machine(sandbox_id="sbx_nope").ensure_connected()


@pytest.mark.asyncio
async def test_a_brought_sandbox_gets_the_configs_network_policy(fake):
    await _brought(fake, allowed_domains=["pypi.org"])
    assert fake.egress == {"sbx_1": {"internet": False, "allow": ["pypi.org"]}}


@pytest.mark.asyncio
async def test_a_brought_sandbox_keeps_its_own_policy_unless_set(fake):
    await _brought(fake)
    assert fake.egress == {}


@pytest.mark.asyncio
async def test_without_an_id_mirage_starts_one_and_remembers_it(fake):
    machine = _machine(
        template="code",
        idle_timeout=12.5,
        denied_domains=["gist.github.com"],
        secrets=["OPENAI_API_KEY"],
    )
    memory = Memory()
    machine.bind_memory(memory)
    await machine.ensure_connected()
    assert fake.created == [
        {
            "sleep_after_s": 13,
            "labels": {"mirage_machine": "box"},
            "template": "code",
            "egress": {"internet": True, "deny": ["gist.github.com"]},
            "secrets": ["OPENAI_API_KEY"],
        }
    ]
    assert memory.kept == {"box": "sbx_1"}
    assert machine.started_by_mirage and machine.instance == "sbx_1"


@pytest.mark.asyncio
async def test_a_started_sandbox_sleeps_after_a_minute_by_default(fake):
    await _machine(image="python:3.12-slim").ensure_connected()
    assert fake.created == [
        {
            "sleep_after_s": 60,
            "labels": {"mirage_machine": "box"},
            "image": "python:3.12-slim",
        }
    ]


@pytest.mark.asyncio
async def test_a_later_build_reaches_the_sandbox_it_started(fake):
    sandbox_id = fake.add("sleeping")
    machine = _machine()
    machine.bind_memory(Memory({"box": sandbox_id}))
    await machine.ensure_connected()
    assert fake.created == []
    assert machine.started_by_mirage and machine.instance == sandbox_id


@pytest.mark.asyncio
async def test_a_started_sandbox_that_is_gone_is_started_anew(fake):
    gone = fake.add("deleted")
    memory = Memory({"box": gone})
    machine = _machine()
    machine.bind_memory(memory)
    await machine.ensure_connected()
    assert len(fake.created) == 1
    assert memory.kept == {"box": "sbx_2"}


@pytest.mark.asyncio
async def test_a_sandbox_booting_from_an_image_is_waited_for(
    fake, monkeypatch
):
    monkeypatch.setattr("mirage.machine.kosa8.handle.START_POLL_SECONDS", 0.01)
    fake.create_state = "creating"
    machine = _machine(image="debian:12")
    await machine.ensure_connected()
    assert ("GET", "/v1/sandboxes/sbx_1") in fake.calls


@pytest.mark.asyncio
async def test_a_sandbox_that_fails_to_boot_is_deleted(fake, monkeypatch):
    monkeypatch.setattr("mirage.machine.kosa8.handle.START_POLL_SECONDS", 0.01)
    fake.create_state, fake.later_state = "creating", "error"
    with pytest.raises(RuntimeError, match="did not start"):
        await _machine(image="debian:12").ensure_connected()
    assert fake.sandboxes["sbx_1"]["state"] == "deleted"


@pytest.mark.asyncio
async def test_a_sandbox_the_workspace_cannot_keep_is_deleted(fake):
    machine = _machine()
    machine.bind_memory(Memory(fail=True))
    with pytest.raises(OSError, match="store is down"):
        await machine.ensure_connected()
    assert fake.sandboxes["sbx_1"]["state"] == "deleted"
    assert not machine.started_by_mirage


@pytest.mark.asyncio
async def test_a_line_runs_under_the_prelude_with_its_cwd_and_env(
    fake, tmp_path
):
    machine = await _brought(fake)
    result = await machine.exec_line(
        'pwd; echo "$E"', None, {"E": "v 1"}, str(tmp_path)
    )
    assert (result.exit_code, result.stdout, result.stderr) == (
        0,
        f"{tmp_path}\nv 1\n".encode(),
        b"",
    )
    argv = fake.execs[0]
    assert argv[:7] == [
        "/bin/sh",
        "-c",
        PRELUDE,
        "sh",
        "",
        str(tmp_path),
        "env",
    ]
    assert "E=v 1" in argv and argv[-3:] == ["/bin/sh", "-c", 'pwd; echo "$E"']


@pytest.mark.asyncio
async def test_a_missing_cwd_exits_126(fake):
    machine = await _brought(fake)
    result = await machine.exec_line("true", None, {}, "/no/such/dir")
    assert result.exit_code == 126


@pytest.mark.asyncio
async def test_bytes_and_the_exit_code_come_back_exactly(fake):
    machine = await _brought(fake)
    result = await machine.exec_line(
        "printf 'a\\377\\000b\\r\\n'; printf 'e\\376\\000' >&2; exit 5",
        None,
        {},
        "/",
    )
    assert (result.exit_code, result.stdout, result.stderr) == (
        5,
        b"a\xff\x00b\r\n",
        b"e\xfe\x00",
    )


@pytest.mark.asyncio
async def test_no_input_reads_as_empty(fake):
    machine = await _brought(fake)
    result = await machine.exec_line("wc -c", None, {}, "/")
    assert result.stdout.strip() == b"0"


@pytest.mark.asyncio
async def test_input_is_uploaded_whole_and_read_as_stdin(fake):
    machine = await _brought(fake)
    data = bytes(range(256)) * 1000

    async def parts():
        yield data[:1000]
        yield data[1000:]

    result = await machine.exec_line("cat", parts(), {}, "/")
    assert result.stdout == data
    [staged] = fake.uploads
    assert re.search(r"/\.mirage/in-[0-9a-f]{32}$", staged)
    assert str(fake.home) in staged
    assert not Path(staged).exists()


@pytest.mark.asyncio
async def test_input_past_the_limit_fails_the_line(fake, monkeypatch):
    monkeypatch.setattr(Kosa8Machine, "input_limit", 10)
    machine = await _brought(fake)
    result = await machine.exec_line("cat", b"x" * 11, {}, "/")
    assert result.exit_code == 126
    assert b"input past 10 bytes" in result.stderr
    assert fake.execs == [fake.execs[0]] and "printf" in fake.execs[0][-1]
    assert not list((fake.home / ".mirage").iterdir())


@pytest.mark.asyncio
async def test_a_line_too_long_for_one_exec_is_staged_as_a_script(fake):
    machine = await _brought(fake)
    # 5,000 characters, 10,000 UTF-16 units: past what kosa8 counts.
    word = "\U0001d11e" * 5000
    result = await machine.exec_line(
        f"printf %s '{word}' | wc -c", None, {}, "/"
    )
    assert result.stdout.strip() == str(len(word.encode())).encode()
    argv = fake.execs[-1]
    assert argv[0] == "/bin/sh" and len(argv) == 2
    assert re.search(r"/\.mirage/run-[0-9a-f]{32}$", argv[1])
    assert not Path(argv[1]).exists()


@pytest.mark.asyncio
async def test_many_variables_are_staged_too(fake):
    machine = await _brought(fake)
    env = {f"V{i}": str(i) for i in range(300)}
    result = await machine.exec_line('echo "$V299"', None, env, "/")
    assert result.stdout == b"299\n"
    assert len(fake.execs[-1]) == 2


@pytest.mark.asyncio
async def test_the_machine_folder_is_asked_once(fake):
    machine = await _brought(fake)
    await machine.exec_line("cat", b"a", {}, "/")
    await machine.exec_line("cat", b"b", {}, "/")
    folders = [argv for argv in fake.execs if 'printf %s "$d"' in argv[-1]]
    assert len(folders) == 1


@pytest.mark.asyncio
async def test_a_cancelled_line_is_stopped_by_its_tag(fake, tmp_path):
    machine = await _brought(fake)
    ready = tmp_path / "ready"
    line = asyncio.create_task(
        machine.exec_line(f"echo $$ > {ready}; sleep 30", None, {}, "/")
    )
    async with asyncio.timeout(10):
        while not ready.exists() or not ready.read_text().strip():
            await asyncio.sleep(0.01)
    pid = int(ready.read_text())
    line.cancel()
    with pytest.raises(asyncio.CancelledError):
        await line
    tags = [
        w.split("=", 1)[1]
        for w in fake.execs[0]
        if w.startswith(f"{PROCESS}=")
    ]
    assert len(tags) == 1
    assert any(stop_line(tags[0], 15) in argv[-1] for argv in fake.execs[1:])
    if not os.path.isdir("/proc"):
        return  # The stop line finds a run's processes through /proc.
    async with asyncio.timeout(10):
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.05)


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.path.isdir("/proc"),
    reason="the stop line finds a run's processes through /proc",
)
async def test_a_kill_reaches_the_program_with_its_signal(fake, tmp_path):
    ready, seen = tmp_path / "ready", tmp_path / "seen"
    box = _machine(sandbox_id=fake.add())
    ctx = Context(
        flags={
            "c": f"trap 'echo INT >> {seen}; exit 0' INT; "
            f"trap 'echo TERM >> {seen}; exit 0' TERM; "
            f"echo up > {ready}; while :; do sleep 1; done"
        },
        env=None,
        cwd=PathSpec.from_str_path("/"),
    )

    async def run() -> int:
        return (await machine_answer(box, [], ctx, "line")).exit_code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s", command="sh", cwd=ctx.cwd, run=run
    )
    async with asyncio.timeout(10):
        while not ready.exists():
            await asyncio.sleep(0.01)
        assert runner.terminate(signal.SIGINT)
        assert (await runner.join()).exit == 130
    assert seen.read_text() == "INT\n"


@pytest.mark.asyncio
async def test_a_dropped_stream_keeps_what_the_line_read(fake):
    machine = await _brought(fake)
    fake.cut_after = 1
    out, err = bytearray(), bytearray()

    async def keep_out(data):
        out.extend(data)

    async def keep_err(data):
        err.extend(data)

    with pytest.raises(
        ConnectionLostError, match="kosa8 could not be reached"
    ):
        await machine._exec_argv(
            ("/bin/sh", "-c", "echo out; sleep 0.3; echo more"),
            None,
            {},
            "/",
            keep_out,
            keep_err,
        )
    assert bytes(out) == b"out\n"
    assert bytes(err).startswith(b"kosa8: kosa8 could not be reached")


@pytest.mark.asyncio
async def test_a_dropped_connection_loses_the_line_and_reconnects(fake):
    box = _machine(sandbox_id=fake.add())
    ctx = Context(
        flags={"c": "echo hi"}, env=None, cwd=PathSpec.from_str_path("/")
    )
    fake.exec_status = 503
    result = await machine_answer(box, [], ctx, "line")
    assert result.exit_code == 129
    assert b"mirage: kosa8:box: connection lost\n" in result.stderr
    fake.exec_status = None
    again = await machine_answer(box, [], ctx, "line")
    assert (again.exit_code, again.stdout) == (0, b"hi\n")
    assert fake.calls.count(("GET", "/v1/sandboxes/sbx_1")) == 2


@pytest.mark.asyncio
async def test_a_sandbox_deleted_under_a_line_says_what_to_do(fake):
    machine = await _brought(fake)
    fake.sandboxes["sbx_1"]["state"] = "deleted"
    with pytest.raises(
        ConnectionLostError,
        match="sandbox sbx_1 is not running: it was deleted",
    ):
        await machine.exec_line("echo hi", None, {}, "/")


@pytest.mark.asyncio
async def test_close_releases_the_client_and_leaves_the_sandbox(fake):
    machine = await _brought(fake)
    await machine.close()
    assert machine._api is None
    assert fake.sandboxes["sbx_1"]["state"] == "running"


@pytest.mark.asyncio
async def test_pause_puts_a_reached_sandbox_to_sleep(fake):
    machine = await _brought(fake, on_pause="pause")
    assert machine.config_asks_to_pause()
    await machine.close()
    await machine.pause()
    assert fake.sandboxes["sbx_1"]["state"] == "sleeping"


@pytest.mark.asyncio
async def test_pause_of_a_sandbox_already_gone_is_quiet(fake):
    machine = await _brought(fake)
    await machine.close()
    fake.sandboxes["sbx_1"]["state"] = "deleted"
    await machine.pause()


@pytest.mark.asyncio
async def test_destroy_deletes_only_a_sandbox_mirage_started(fake):
    brought = await _brought(fake)
    await brought.destroy()
    assert fake.sandboxes["sbx_1"]["state"] == "running"
    memory = Memory()
    started = _machine()
    started.bind_memory(memory)
    await started.ensure_connected()
    await started.destroy()
    assert fake.sandboxes["sbx_2"]["state"] == "deleted"
    assert memory.kept == {}


@pytest.mark.asyncio
async def test_destroy_reaches_the_remembered_sandbox_without_connecting(fake):
    sandbox_id = fake.add("sleeping")
    machine = _machine()
    machine.bind_memory(Memory({"box": sandbox_id}))
    await machine.destroy()
    assert fake.sandboxes[sandbox_id]["state"] == "deleted"


def test_registers_under_the_config_name_kosa8():
    machine = build_machine(
        "box", {"provider": "kosa8", "sandbox_id": "sbx_1"}
    )
    assert isinstance(machine, Kosa8Machine)
    assert str(machine.machine) == "kosa8:box"


def test_mount_type_is_refused():
    with pytest.raises(ValueError, match="kosa8: mount_type needs a pipe"):
        _machine(mount_type="ssh")


@pytest.mark.asyncio
async def test_a_workspace_runs_captured_programs_on_the_sandbox(fake):
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "box": {
                "provider": "kosa8",
                "sandbox_id": fake.add(),
                "captures": ["@python", "@external"],
            }
        },
    )
    try:
        await ws.shell("cat > /data/in.txt", stdin=b"alpha\nbeta\n")
        result = await ws.shell(
            "cat /data/in.txt | python3 -c "
            "'import sys; print(sys.stdin.read().upper(), end=\"\")'"
        )
        assert (result.exit_code, await result.stdout_str()) == (
            0,
            "ALPHA\nBETA\n",
        )
    finally:
        await ws.close()
