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

from mirage import MountMode, Workspace
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec import CommandSpec
from mirage.io.types import IOResult
from mirage.shell.console import Channel, JobConsole
from mirage.utils.abort import MirageAbortError, cancellable_sleep
from mirage.vfs.ram import RAMVFS
from mirage.workspace.executor.builtins.sleep.sleep import handle_sleep


def _held(reading: asyncio.Event, release: asyncio.Event):
    async def chunks():
        reading.set()
        await release.wait()
        yield b"go\n"

    return chunks()


class _Stalled(JobConsole):
    def __init__(self, reached: asyncio.Event) -> None:
        super().__init__()
        self.reached = reached

    async def emit(self, channel: Channel, data: bytes) -> None:
        self.reached.set()
        await asyncio.Event().wait()


class _Held(JobConsole):
    def __init__(self, reached: asyncio.Event) -> None:
        super().__init__()
        self.reached = reached
        self.release = asyncio.Event()

    async def emit(self, channel: Channel, data: bytes) -> None:
        self.reached.set()
        await self.release.wait()
        await super().emit(channel, data)


def _make_ws():
    vfs = RAMVFS()
    store = vfs._store
    store.dirs.add("/")
    store.dirs.add("/subdir")
    store.dirs.add("/other")
    store.files["/subdir/file.txt"] = b"hello"
    store.modified["/subdir/file.txt"] = "2024-01-01"
    return Workspace({"/ram/": vfs}, mode=MountMode.WRITE)


# ── cwd tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cwd_runs_in_override():
    ws = _make_ws()
    r = await ws.shell("pwd", cwd="/ram/subdir")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_cwd_does_not_mutate_session():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    await ws.shell("pwd", cwd="/ram/subdir")
    after = ws.get_session(ws.default_session_id).cwd
    assert before == after


@pytest.mark.asyncio
async def test_cwd_cd_does_not_leak():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    await ws.shell("cd /ram/subdir", cwd="/ram")
    after = ws.get_session(ws.default_session_id).cwd
    assert before == after


@pytest.mark.asyncio
async def test_cwd_parallel_isolation():
    ws = _make_ws()
    r1, r2 = await asyncio.gather(
        ws.shell("pwd", cwd="/ram/subdir"),
        ws.shell("pwd", cwd="/ram/other"),
    )
    assert (await r1.stdout_str()).strip() == "/ram/subdir"
    assert (await r2.stdout_str()).strip() == "/ram/other"


@pytest.mark.asyncio
async def test_setup_persists_overrides_inherit():
    ws = _make_ws()
    await ws.shell("export DEBUG=1")
    assert ws.get_session(ws.default_session_id).env.get("DEBUG") == "1"
    before_cwd = ws.get_session(ws.default_session_id).cwd
    r = await ws.shell("printenv DEBUG", cwd="/ram/subdir")
    assert (await r.stdout_str()).strip() == "1"
    assert ws.get_session(ws.default_session_id).cwd == before_cwd
    assert ws.get_session(ws.default_session_id).env.get("DEBUG") == "1"


@pytest.mark.asyncio
async def test_function_definitions_do_not_leak():
    ws = _make_ws()
    await ws.shell("greet() { echo hi; }", cwd="/ram/subdir")
    session = ws.get_session(ws.default_session_id)
    assert "greet" not in session.functions


@pytest.mark.asyncio
async def test_cwd_leaves_its_status_in_the_session():
    ws = _make_ws()
    await ws.shell("false", cwd="/ram/subdir")
    assert ws.get_session(ws.default_session_id).last_exit_code == 1


# ── env tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_env_exposes_override():
    ws = _make_ws()
    r = await ws.shell("printenv FOO", env={"FOO": "bar"})
    assert r.exit_code == 0
    assert (await r.stdout_str()).strip() == "bar"


@pytest.mark.asyncio
async def test_env_does_not_mutate_session():
    ws = _make_ws()
    before = dict(ws.get_session(ws.default_session_id).env)
    await ws.shell("printenv FOO", env={"FOO": "bar"})
    after = dict(ws.get_session(ws.default_session_id).env)
    assert before == after


@pytest.mark.asyncio
async def test_env_export_does_not_leak():
    ws = _make_ws()
    await ws.shell("export LEAKED=yes", env={"FOO": "bar"})
    assert "LEAKED" not in ws.get_session(ws.default_session_id).env


@pytest.mark.asyncio
async def test_env_layers_onto_session():
    ws = _make_ws()
    await ws.shell("export BASE=keep")
    assert ws.get_session(ws.default_session_id).env.get("BASE") == "keep"
    r_base = await ws.shell("printenv BASE", env={"FOO": "bar"})
    assert (await r_base.stdout_str()).strip() == "keep"
    r_foo = await ws.shell("printenv FOO", env={"FOO": "bar"})
    assert (await r_foo.stdout_str()).strip() == "bar"
    session_env = ws.get_session(ws.default_session_id).env
    assert session_env.get("BASE") == "keep"
    assert "FOO" not in session_env


@pytest.mark.asyncio
async def test_env_parallel_isolation():
    ws = _make_ws()
    r1, r2 = await asyncio.gather(
        ws.shell("printenv FOO", env={"FOO": "one"}),
        ws.shell("printenv FOO", env={"FOO": "two"}),
    )
    assert (await r1.stdout_str()).strip() == "one"
    assert (await r2.stdout_str()).strip() == "two"


# ── a process of its own ─────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("own", [{"cwd": "/ram"}, {}])
async def test_a_per_call_line_runs_beside_the_sessions_line(own):
    ws = _make_ws()
    reading, release = asyncio.Event(), asyncio.Event()
    slow = asyncio.create_task(
        ws.shell("read x; echo got:$x", stdin=_held(reading, release), **own)
    )
    await asyncio.wait_for(reading.wait(), 5)
    fast = await asyncio.wait_for(ws.shell("echo fast", cwd="/ram"), 5)
    assert not slow.done()
    release.set()
    assert (await (await slow).stdout_str()) == "got:go\n"
    assert (await fast.stdout_str()) == "fast\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_per_call_lines_wait_sees_only_its_own_jobs():
    ws = _make_ws()
    reading, release = asyncio.Event(), asyncio.Event()
    holder = asyncio.create_task(
        ws.shell(
            "sleep 30 & read x", cwd="/ram", stdin=_held(reading, release)
        )
    )
    await asyncio.wait_for(reading.wait(), 5)
    done = await asyncio.wait_for(ws.shell("wait; echo done", cwd="/ram"), 5)
    release.set()
    await holder
    assert (await done.stdout_str()) == "done\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_job_writes_to_the_per_call_line_that_started_it():
    ws = _make_ws()
    reading, release = asyncio.Event(), asyncio.Event()
    a = asyncio.create_task(
        ws.shell(
            "{ while [ ! -f /ram/go ]; do sleep 0.05; done; echo from-a; }"
            " & touch /ram/waiting; wait",
            cwd="/ram",
        )
    )
    while not await ws.vfs.exists("/ram/waiting"):
        await asyncio.sleep(0.01)
    b = asyncio.create_task(
        ws.shell(
            "read x; echo got:$x", cwd="/ram", stdin=_held(reading, release)
        )
    )
    await asyncio.wait_for(reading.wait(), 5)
    await ws.shell("touch /ram/go", cwd="/ram")
    out_a = await asyncio.wait_for(a, 5)
    release.set()
    out_b = await b
    assert (await out_a.stdout_str()) == "from-a\n"
    assert (await out_b.stdout_str()) == "got:go\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_callback_in_a_per_call_line_waits_on_its_jobs():
    ws = _make_ws()

    async def again(config, paths, texts, ctx):
        inner = await ws.shell("wait %1; echo $?")
        return inner.stdout, IOResult()

    ws.register_cli(
        "again",
        CLI(
            spec=CommandSpec(name="again"), handlers={"": CLIHandler(fn=again)}
        ),
    )
    io = await ws.shell("sleep 0.1 & again", cwd="/ram")
    assert (await io.stdout_str()) == "0\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_job_that_outlives_its_line_writes_to_the_next():
    ws = _make_ws()
    await ws.shell(
        "{ while [ ! -f /ram/go ]; do sleep 0.01; done; echo late;"
        " touch /ram/done; } &",
        cwd="/ram",
    )
    await ws.shell("touch /ram/go", cwd="/ram")
    while not await ws.vfs.exists("/ram/done"):
        await asyncio.sleep(0.01)
    io = await ws.shell("echo next", cwd="/ram")
    assert (await io.stdout_str()) == "late\nnext\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_per_call_line_leaves_a_running_lines_output_to_it():
    ws = _make_ws()
    await ws.shell(
        "{ sleep 0.05; echo late1; echo late2; touch /ram/done; } &"
    )
    while not await ws.vfs.exists("/ram/done"):
        await asyncio.sleep(0.01)
    reached = asyncio.Event()
    reader = _Held(reached)
    typed = asyncio.create_task(ws.shell("echo typed", sink=reader))
    await asyncio.wait_for(reached.wait(), 5)
    fast = await asyncio.wait_for(ws.shell("echo fast", cwd="/ram"), 5)
    reader.release.set()
    await asyncio.wait_for(typed, 5)
    assert (await fast.stdout_str()) == "fast\n"
    assert await reader.snapshot(Channel.STDOUT) == b"late1\nlate2\ntyped\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_cancelled_per_call_line_hands_its_jobs_output_on_unheld():
    ws = _make_ws()
    await ws.shell(
        "{ sleep 0.05; echo w1; echo w2; touch /ram/j1;"
        " while [ ! -f /ram/go ]; do sleep 0.01; done;"
        " echo w3; touch /ram/j2; } &"
    )
    while not await ws.vfs.exists("/ram/j1"):
        await asyncio.sleep(0.01)
    own_reached, cancel = asyncio.Event(), asyncio.Event()
    own = _Held(own_reached)
    call = asyncio.create_task(
        ws.shell("echo c", cwd="/ram", sink=own, cancel=cancel)
    )
    await asyncio.wait_for(own_reached.wait(), 5)
    await ws.vfs.write("/ram/go", b"")
    while not await ws.vfs.exists("/ram/j2"):
        await asyncio.sleep(0.01)
    reached = asyncio.Event()
    reader = _Held(reached)
    typed = asyncio.create_task(ws.shell("echo typed", sink=reader))
    await asyncio.wait_for(reached.wait(), 5)
    cancel.set()
    with pytest.raises(MirageAbortError):
        await asyncio.wait_for(call, 5)
    reader.release.set()
    own.release.set()
    await asyncio.wait_for(typed, 5)
    assert await reader.snapshot(Channel.STDOUT) == b"w3\nw2\ntyped\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_cancelled_per_call_line_leaves_the_status():
    ws = _make_ws()
    reached, cancel = asyncio.Event(), asyncio.Event()
    call = asyncio.create_task(
        ws.shell("echo $((", cwd="/ram", sink=_Stalled(reached), cancel=cancel)
    )
    await asyncio.wait_for(reached.wait(), 5)
    cancel.set()
    with pytest.raises(MirageAbortError):
        await call
    assert ws.get_session(ws.default_session_id).last_exit_code == 0
    await ws.close()


# ── mid-flight cancel ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cancel_pre_set_raises_immediately():
    ws = _make_ws()
    cancel = asyncio.Event()
    cancel.set()
    with pytest.raises(Exception) as exc_info:
        await ws.shell("echo hi", cancel=cancel)
    assert "abort" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_cancel_aborts_sleep_within_timeout():
    ws = _make_ws()
    cancel = asyncio.Event()

    async def trigger() -> None:
        await asyncio.sleep(0.1)
        cancel.set()

    asyncio.create_task(trigger())
    t0 = asyncio.get_event_loop().time()
    with pytest.raises(Exception):
        await ws.shell("sleep 5", cancel=cancel)
    assert asyncio.get_event_loop().time() - t0 < 1.0


@pytest.mark.asyncio
async def test_cancel_inside_for_loop():
    ws = _make_ws()
    cancel = asyncio.Event()

    async def trigger() -> None:
        await asyncio.sleep(0.1)
        cancel.set()

    asyncio.create_task(trigger())
    t0 = asyncio.get_event_loop().time()
    with pytest.raises(Exception):
        await ws.shell(
            "for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; done",
            cancel=cancel,
        )
    assert asyncio.get_event_loop().time() - t0 < 1.5


@pytest.mark.asyncio
async def test_cancel_between_list_stages():
    ws = _make_ws()
    cancel = asyncio.Event()

    async def trigger() -> None:
        await asyncio.sleep(0.1)
        cancel.set()

    asyncio.create_task(trigger())
    t0 = asyncio.get_event_loop().time()
    with pytest.raises(Exception):
        await ws.shell(
            "sleep 1 && sleep 1 && sleep 1 && echo done",
            cancel=cancel,
        )
    assert asyncio.get_event_loop().time() - t0 < 2.0


@pytest.mark.asyncio
async def test_cancel_inside_command_substitution(monkeypatch):
    ws = _make_ws()
    cancel = asyncio.Event()
    entered = asyncio.Event()
    exited = asyncio.Event()

    async def tracked_sleep(seconds, event):
        entered.set()
        try:
            await cancellable_sleep(seconds, event)
        finally:
            exited.set()

    monkeypatch.setitem(
        handle_sleep.__globals__, "cancellable_sleep", tracked_sleep
    )
    task = asyncio.create_task(ws.shell('echo "$(sleep 3600)"', cancel=cancel))
    try:
        # Synchronize on the inner command, not parsing/runner wall time.
        await asyncio.wait_for(entered.wait(), timeout=10)
        cancel.set()
        with pytest.raises(MirageAbortError):
            await asyncio.wait_for(task, timeout=10)
        assert exited.is_set()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
async def test_cancel_workspace_remains_usable():
    ws = _make_ws()
    cancel = asyncio.Event()

    async def trigger() -> None:
        await asyncio.sleep(0.05)
        cancel.set()

    asyncio.create_task(trigger())
    with pytest.raises(Exception):
        await ws.shell("sleep 5", cancel=cancel)
    r = await ws.shell("echo recovered")
    assert r.exit_code == 0
    assert r.stdout.decode().strip() == "recovered"


# ── agent harness pattern ─────────────────────────────────────────


async def _tool_call(ws, cmd, cwd_v, env_v, timeout):
    cancel = asyncio.Event()
    asyncio.get_event_loop().call_later(timeout, cancel.set)
    return await ws.shell(cmd, cwd=cwd_v, env=env_v, cancel=cancel)


@pytest.mark.asyncio
async def test_agent_pattern_parallel_tool_calls_each_with_own_options():
    ws = _make_ws()
    a, b = await asyncio.gather(
        _tool_call(
            ws, "pwd; printenv DEBUG", "/ram/subdir", {"DEBUG": "one"}, 5.0
        ),
        _tool_call(ws, "pwd; printenv DEBUG", "/ram", {"DEBUG": "two"}, 5.0),
    )
    assert "/ram/subdir" in a.stdout.decode()
    assert "one" in a.stdout.decode()
    assert "/ram" in b.stdout.decode()
    assert "two" in b.stdout.decode()
    session = ws.get_session(ws.default_session_id)
    assert session.cwd != "/ram/subdir"
    assert "DEBUG" not in session.env


@pytest.mark.asyncio
async def test_execute_uses_custom_default_session_id():
    vfs = RAMVFS()
    vfs._store.dirs.add("/")
    ws = Workspace({"/ram/": vfs}, mode=MountMode.WRITE, session_id="mysess")
    r = await ws.shell("echo hi > /ram/f.txt")
    assert r.exit_code == 0
    r2 = await ws.shell("cat /ram/f.txt")
    assert (await r2.stdout_str()).strip() == "hi"


@pytest.mark.asyncio
async def test_agent_pattern_one_aborts_while_siblings_complete():
    ws = _make_ws()
    settled = await asyncio.gather(
        _tool_call(ws, "sleep 5", "/ram/subdir", {"DEBUG": "one"}, 0.1),
        _tool_call(ws, "echo ok", "/ram", {"DEBUG": "two"}, 5.0),
        return_exceptions=True,
    )
    assert isinstance(settled[0], Exception)
    assert "abort" in str(settled[0]).lower()
    assert not isinstance(settled[1], Exception)
    assert settled[1].stdout.decode().strip() == "ok"


@pytest.mark.asyncio
async def test_a_queued_line_runs_after_the_aborted_one_and_keeps_its_status():
    # One session runs one line at a time (#1144): B waits for A, so A's
    # abort restores the `$?` it found before B ever stamps its own, and
    # the shell ends on B's status, never on a resurrected older one.
    ws = _make_ws()
    await ws.shell("true")

    cancel = asyncio.Event()
    blocked = asyncio.create_task(ws.shell("sleep 5", cancel=cancel))
    # Let the blocked line reach its snapshot before the other queues.
    await asyncio.sleep(0.05)

    queued = asyncio.create_task(ws.shell("false"))
    await asyncio.sleep(0)

    cancel.set()
    with pytest.raises(Exception):
        await blocked
    await queued

    r = await ws.shell("echo $?")
    assert r.stdout.decode().strip() == "1"
