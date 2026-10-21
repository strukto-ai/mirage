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
import shlex
from datetime import datetime, timedelta, timezone

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.cache.index.config import LookupStatus
from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.sandbox import RemoteSandbox, SandboxConfig
from mirage.runtime.sandbox.constants import EXEC_ID, reap_line
from mirage.runtime.types import RunResult
from mirage.types import FileStat, FileType, Limit, PathSpec


class RecordingSandbox(RemoteSandbox):
    name = "recbox"

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.execs: list[tuple[str, bytes | None, str]] = []
        self.exec_envs: list[dict[str, str]] = []
        self.connected = 0

    async def connect(self) -> None:
        self.connected += 1

    async def _exec_argv(self, argv, stdin, env, cwd, output):
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        return await self.exec_line(line, data, env, cwd)

    async def exec_line(
        self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
    ) -> RunResult:
        self.execs.append((line, stdin, cwd))
        self.exec_envs.append(dict(env))
        return RunResult(
            stdout=b"ran:" + line.encode(), stderr=None, exit_code=0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "python3 --version",
        "python -V",
        "node --version",
        "node -v",
        "tsc --version",
    ],
)
async def test_version_commands_reach_the_remote_environment(line):
    box = RecordingSandbox(captures=(line.split()[0],))
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    try:
        io = await ws.shell(line)
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"ran:" + line.encode()
        assert box.execs[0][0] == line
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_first_line_connects_once():
    box = RecordingSandbox(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    try:
        io = await ws.shell("python3 x")
        assert await materialize(io.stdout) == b"ran:python3 x"
        assert box.connected == 1
        await ws.shell("python3 x")
        # The runtime connects on the first line, not per line.
        assert box.connected == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_failed_connect_retries_on_the_next_line():
    class FlakyBox(RecordingSandbox):
        async def connect(self) -> None:
            await super().connect()
            if self.connected == 1:
                raise RuntimeError("sandbox not running")

    box = FlakyBox(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    try:
        io = await ws.shell("python3 x")
        assert io.exit_code != 0
        assert b"not running" in await materialize(io.stderr)
        io = await ws.shell("python3 x")
        assert io.exit_code == 0
        assert box.connected == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cwd_passes_through_verbatim_and_env_merges():
    box = RecordingSandbox(captures=("*",), config={"env": {"BASE": "1"}})
    cwd = PathSpec.from_str_path("/data/deep")
    ctx = Context(flags={"c": "nvidia-smi"}, env={"LINE": "2"}, cwd=cwd)
    result = await box.run_line(None, [], [], ctx)
    assert result.exit_code == 0
    # The sandbox serves the workspace at the same prefixes as the
    # host, so nothing is rewritten.
    assert box.execs[-1][2] == "/data/deep"
    assert box.exec_envs[-1]["BASE"] == "1"
    assert box.exec_envs[-1]["LINE"] == "2"


@pytest.mark.asyncio
async def test_stdin_bytes_reach_exec_line():
    box = RecordingSandbox(captures=("*",))
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    try:
        await ws.shell("wc -l", stdin=b"a\nb\n")
        assert box.execs[-1][1] == b"a\nb\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_sandboxes_take_lines_not_stages():
    # A sandbox is a line executor, never the engine inside one
    # command: it carries the line entry point and no interpreter entry point.
    box = RecordingSandbox()
    assert isinstance(box, LineExecutorMixin)
    assert not isinstance(box, LanguageRuntime)
    with pytest.raises(UnsupportedExecutionError, match="code execution"):
        await box.execute([], [], Context(flags={"c": "print(1)"}))


def test_config_dict_form_coerces():
    box = RecordingSandbox(config={"env": {"A": "1"}})
    assert box.config == SandboxConfig(env={"A": "1"})


@pytest.mark.asyncio
async def test_line_timeout_answers_124():
    class SlowBox(RecordingSandbox):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            await asyncio.sleep(0.5)
            return await super().exec_line(line, stdin, env, cwd)

    guards = {"python3": Limit(timeout_seconds=0.05)}
    box = SlowBox(captures=("python3",))
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.EXEC, guards)},
        mode=MountMode.EXEC,
        runtimes=[box, "workspace"],
    )
    try:
        # A captured line obeys the same command_limits as any
        # command: the mount's python3 timeout answers exit 124.
        io = await ws.shell("python3 train.py")
        assert io.exit_code == 124
        assert b"timed out" in await materialize(io.stderr)
    finally:
        await ws.close()


# A run cancelled midway (head closed its pipe, a timeout) may leave its
# program running in the box, so every process it started is stopped by
# the run's id, with one more exec that carries no id of its own.
@pytest.mark.asyncio
async def test_a_cancelled_run_stops_what_it_left_in_the_box():
    class StuckBox(RecordingSandbox):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            result = await super().exec_line(line, stdin, env, cwd)
            if line == "yes":
                await asyncio.Event().wait()
            return result

    box = StuckBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))
    task = asyncio.create_task(box.run_line(None, [], [], ctx))
    while not box.execs:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    exec_id = box.exec_envs[0][EXEC_ID]
    assert [line for line, _, _ in box.execs] == ["yes", reap_line(exec_id)]
    assert EXEC_ID not in box.exec_envs[1]


@pytest.mark.asyncio
async def test_a_box_that_stops_answering_holds_a_cancel_only_so_long(
    monkeypatch,
):
    class DeadBox(RecordingSandbox):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            await super().exec_line(line, stdin, env, cwd)
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    monkeypatch.setattr("mirage.runtime.sandbox.base.REAP_WAIT_SECONDS", 0.01)
    box = DeadBox(captures=("yes",))
    ctx = Context(flags={"c": "yes"}, cwd=PathSpec.from_str_path("/"))
    task = asyncio.create_task(box.run_line(None, [], [], ctx))
    while not box.execs:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    assert len(box.execs) == 2


@pytest.mark.asyncio
async def test_line_output_caps_truncate_with_notice():
    class ChattyBox(RecordingSandbox):
        async def exec_line(
            self, line: str, stdin: bytes | None, env: dict[str, str], cwd: str
        ) -> RunResult:
            return RunResult(stdout=b"a\nb\nc\n", stderr=None, exit_code=0)

    guards = {"python3": Limit(max_lines=2)}
    box = ChattyBox(captures=("python3",))
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.EXEC, guards)},
        mode=MountMode.EXEC,
        runtimes=[box, "workspace"],
    )
    try:
        io = await ws.shell("python3 train.py")
        assert io.exit_code == 0
        assert await materialize(io.stdout) == b"a\nb\n"
        assert b"truncated at limit" in await materialize(io.stderr)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_remote_line_invalidates_local_read_caches():
    box = RecordingSandbox(captures=("python3",))
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box, "workspace"]
    )
    try:
        mount = next(m for m in ws._registry.mounts() if m.prefix == "/data/")
        stale = FileStat(
            name="stale.txt", type=FileType.FILE, fingerprint="stale"
        )
        live = datetime.now(timezone.utc) + timedelta(hours=1)
        await mount.index_store.set_dir("/", [("stale.txt", stale)], live)
        assert (await mount.index_store.list_dir("/")).entries is not None
        await ws.shell("python3 anything")
        # Expired, so the next stat or listing asks the backend again.
        listed = await mount.index_store.list_dir("/")
        assert listed.status is LookupStatus.EXPIRED
    finally:
        await ws.close()


def test_reach_is_remote():
    assert RemoteSandbox.reach == "remote"
