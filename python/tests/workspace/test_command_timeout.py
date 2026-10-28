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
import logging
import time
from functools import partial

import pytest

from mirage import MountMode, Workspace
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import Context
from mirage.commands.spec.types import CommandSpec
from mirage.io import IOResult
from mirage.policy import resolve_producer
from mirage.policy.builtin import output_cap as sg
from mirage.runtime.python import LocalRuntime
from mirage.shell.console import Channel
from mirage.types import Limit, OnExceed
from mirage.utils.abort import MirageAbortError
from mirage.vfs.ram import RAMVFS
from mirage.workspace.lookup.lookup import programs
from mirage.workspace.mount.namespace.ram import RAMNamespaceStore


@pytest.fixture
def restore_defaults():
    snapshot = dict(sg.DEFAULT_COMMAND_LIMITS)
    yield
    sg.DEFAULT_COMMAND_LIMITS.clear()
    sg.DEFAULT_COMMAND_LIMITS.update(snapshot)


def _line(seconds: float | None) -> dict[str, Limit] | None:
    return {"@line": Limit(timeout_seconds=seconds)} if seconds else None


def _ws(limits: dict | None = None, line: float | None = None) -> Workspace:
    vfs = (RAMVFS(), MountMode.WRITE, limits) if limits else RAMVFS()
    return Workspace(
        {"/data": vfs}, mode=MountMode.WRITE, command_limits=_line(line)
    )


@pytest.mark.asyncio
async def test_quick_builtin_under_default_does_not_fire():
    ws = _ws()
    r = await ws.shell("echo hi")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "hi\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("record", [True, False])
async def test_the_line_deadline_cuts_a_long_command(record):
    ws = _ws(line=0.1)
    r = await ws.shell("sleep 2", record=record)
    assert r.exit_code == 124
    assert "line: timed out after 0.1s" in (await r.stderr_str())


@pytest.mark.asyncio
async def test_a_streamed_builtin_runs_under_the_line_deadline():
    ws = _ws(line=0.05)
    r = await ws.shell("printf '2\\n' | xargs sleep")
    assert r.exit_code == 124
    assert "line: timed out after 0.05s" in (await r.stderr_str())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "echo {1..3000000} > /dev/null",
        "set -- $x",
        'a=($x); : "${a[@]}"',
    ],
)
async def test_the_line_deadline_lands_inside_a_long_expansion(line):
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        command_limits=_line(0.3),
        env={"x": "\n".join(str(i) for i in range(1, 2000001))},
    )
    started = time.monotonic()
    r = await ws.shell(line)
    assert r.exit_code == 124
    assert time.monotonic() - started < 1.5


@pytest.mark.asyncio
async def test_mount_override_threaded_via_constructor():
    overrides = {"cat": Limit(max_bytes=42, max_lines=99)}
    ws = _ws(limits=overrides)
    mount = next(m for m in ws._registry._mounts if m.prefix == "/data/")
    assert mount.command_limits["cat"].max_bytes == 42
    assert mount.command_limits["cat"].max_lines == 99


class _SuspendingStore(RAMNamespaceStore):
    """A session store whose write suspends, as a persistent one does."""

    async def cas_set(self, session_id, fields, expected_generation):
        await asyncio.sleep(0.02)
        return await super().cas_set(session_id, fields, expected_generation)


@pytest.mark.asyncio
async def test_timeout_answers_124_when_the_session_store_suspends():
    # The timeout is the line's answer, not an abort of the invocation:
    # the caller's event stays untouched, the line flushes and is
    # recorded, and `$?` is 124.
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        session_store=_SuspendingStore(),
        command_limits=_line(0.05),
    )
    cancel = asyncio.Event()
    r = await ws.shell("export MARK=1; sleep 1", cancel=cancel)
    assert r.exit_code == 124
    assert not cancel.is_set()
    status = await ws.shell("echo $?", cancel=cancel)
    assert (await status.stdout_str()) == "124\n"
    commands = [e["command"] for e in await ws.observer.command_events()]
    assert "export MARK=1; sleep 1" in commands


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "nested", ["x=$(sleep 1)", "eval 'sleep 1'", "sh -c 'sleep 1'"]
)
async def test_a_nested_line_shares_the_line_deadline(nested):
    ws = _ws(line=0.05)
    r = await ws.shell(f"{nested}; echo after", cancel=asyncio.Event())
    assert r.exit_code == 124
    assert (await r.stdout_str()) == ""
    assert (await r.stderr_str()) == "line: timed out after 0.05s\n"


@pytest.mark.asyncio
async def test_foreground_timeout_leaves_a_background_job_alone():
    ws = _ws(line=0.6)
    r = await ws.shell(
        "sleep 0.4; { sleep 0.4; echo bg-done; } & sleep 2",
        cancel=asyncio.Event(),
    )
    assert r.exit_code == 124
    await ws.job_table.wait(1, ws.default_session_id)
    job = ws.job_table.get(1, ws.default_session_id)
    assert job.exit_code == 0
    assert (await job.console.snapshot(Channel.STDOUT)) == b"bg-done\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "job", ["sleep 5", "seq 1 1000000000 > /data/g", "{ sleep 5; echo x; }"]
)
async def test_a_job_runs_under_the_line_limit_from_its_own_start(job):
    ws = _ws(line=0.2)
    r = await ws.shell(f"{job} &")
    assert r.exit_code == 0
    await ws.job_table.wait(1, ws.default_session_id)
    done = ws.job_table.get(1, ws.default_session_id)
    assert done.exit_code == 124
    assert (await done.console.snapshot(Channel.STDOUT)) == b""
    assert (
        await done.console.snapshot(Channel.STDERR)
    ) == b"line: timed out after 0.2s\n"
    assert not list(ws.processes.live())


@pytest.mark.asyncio
async def test_a_lifted_line_limit_lifts_a_job_s_too():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        command_limits={"@line": Limit(timeout_seconds=0)},
    )
    r = await ws.shell("{ sleep 0.3; echo done; } & wait $!; echo $?")
    assert (await r.stdout_str()) == "done\n0\n"


@pytest.mark.asyncio
async def test_a_job_keeps_its_own_status_inside_the_limit():
    ws = _ws(line=1)
    r = await ws.shell("(exit 3) & wait $!; echo $?")
    assert (await r.stdout_str()) == "3\n"


@pytest.mark.asyncio
async def test_cross_mount_cat_honors_command_default_limit(restore_defaults):
    sg.DEFAULT_COMMAND_LIMITS["cat"] = Limit(max_lines=4)
    a = RAMVFS()
    b = RAMVFS()
    a._store.dirs.add("/")
    b._store.dirs.add("/")
    a._store.files["/x.txt"] = b"a\n" * 20
    b._store.files["/y.txt"] = b"b\n" * 20
    ws = Workspace({"/a/": a, "/b/": b}, mode=MountMode.WRITE)
    r = await ws.shell("cat /a/x.txt /b/y.txt")
    out = await r.stdout_str()
    err = await r.stderr_str()
    assert out.count("\n") == 4
    assert "output truncated" in err


def _find_lines(lines: int | None) -> dict[str, Limit]:
    return {"find": Limit(max_lines=lines)} if lines else {}


@pytest.mark.asyncio
@pytest.mark.parametrize("parent,child", [(None, 2), (2, 9)])
async def test_fan_out_uses_tightest_limit_among_mounts(parent, child):
    top = RAMVFS()
    sub = RAMVFS()
    top._store.dirs.add("/")
    top._store.files["/a.txt"] = b"hi\n"
    sub._store.dirs.add("/")
    sub._store.files["/b.txt"] = b"yo\n"
    ws = Workspace(
        {
            "/p/": (top, MountMode.WRITE, _find_lines(parent)),
            "/p/sub/": (sub, MountMode.WRITE, _find_lines(child)),
        },
        mode=MountMode.WRITE,
    )
    r = await ws.shell("find /p")
    assert r.producer is not None
    resolved = resolve_producer(r.producer, ws._registry.limit_mount)
    assert resolved is not None
    assert resolved.max_lines == 2


@pytest.mark.asyncio
async def test_stderr_redirect_does_not_swallow_timeout_exit():
    ws = _ws(line=0.05)
    r = await ws.shell("sleep 2 2>&1")
    assert r.exit_code == 124
    r = await ws.shell("sleep 2 2>&1 | cat")
    assert r.exit_code == 124


async def _record(
    seen: list[str], name: str, config, paths, texts, ctx: Context
) -> tuple[None, IOResult]:
    seen.append(name)
    return None, IOResult()


@pytest.mark.asyncio
async def test_a_killed_subshell_stops_its_exit_action():
    ws = _ws()
    reached: list[str] = []
    for name in ("started", "reached"):
        ws.register_cli(
            name,
            CLI(
                spec=CommandSpec(name=name),
                handlers={"": CLIHandler(fn=partial(_record, reached, name))},
            ),
        )
    running = asyncio.create_task(
        ws.shell('(trap "started; sleep 0.3; reached" EXIT; true); echo after')
    )

    def subshell():
        return next(
            (
                p
                for p in ws.job_table.processes.live()
                if p.info.command.startswith("(trap")
            ),
            None,
        )

    deadline = time.monotonic() + 3
    while subshell() is None:
        assert time.monotonic() < deadline, "the subshell never started"
        await asyncio.sleep(0.005)
    await asyncio.sleep(0.05)
    subshell().terminate()
    with pytest.raises(asyncio.CancelledError):
        await running
    await asyncio.sleep(0.6)
    assert reached == ["started"]


@pytest.mark.asyncio
async def test_truncation_keeps_lazy_exit_zero_on_match():
    ws = _ws({"grep": Limit(max_lines=2)})
    await ws.shell("printf 'a\\na\\na\\na\\n' > /data/f.txt")
    r = await ws.shell("grep a /data/f.txt")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "a\na\n"


@pytest.mark.asyncio
async def test_timeout_preserves_partial_records_and_logs(caplog):
    # The budget starts before the line's passes: one they cannot spend on a
    # loaded runner, so the cat runs before the deadline.
    ws = _ws(line=1.0)
    await ws.shell("echo hello > /data/f.txt")
    before = len(ws._files.records)
    with caplog.at_level(logging.DEBUG, logger="mirage.workspace.workspace"):
        r = await ws.shell("cat /data/f.txt; sleep 5")
    assert r.exit_code == 124
    assert len(ws._files.records) > before
    assert any("timed out" in m for m in caplog.messages)


@pytest.mark.asyncio
async def test_cross_mount_cat_aggregates_tightest_limit():
    a = RAMVFS()
    b = RAMVFS()
    a._store.dirs.add("/")
    b._store.dirs.add("/")
    a._store.files["/x.txt"] = b"1\n2\n3\n"
    b._store.files["/y.txt"] = b"4\n5\n6\n"
    ws = Workspace(
        {
            "/a/": (
                a,
                MountMode.WRITE,
                {"cat": Limit(max_lines=100, on_exceed=OnExceed.TRUNCATE)},
            ),
            "/b/": (
                b,
                MountMode.WRITE,
                {"cat": Limit(max_lines=1, on_exceed=OnExceed.ERROR)},
            ),
        },
        mode=MountMode.WRITE,
    )
    r = await ws.shell("cat /a/x.txt /b/y.txt")
    resolved = resolve_producer(r.producer, ws._registry.limit_mount)
    assert resolved.max_lines == 1
    assert resolved.on_exceed is OnExceed.ERROR


@pytest.mark.asyncio
async def test_the_line_deadline_cuts_a_local_python3():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[LocalRuntime()],
        command_limits=_line(0.2),
    )
    r = await ws.shell('python3 -c "import time; time.sleep(5)"')
    assert r.exit_code == 124
    assert "line: timed out after 0.2s" in (await r.stderr_str())
    await ws.close()


@pytest.mark.asyncio
async def test_python3_timeout_reclaims_monty_interpreter():
    ram = RAMVFS()
    ram._store.files["/spin.py"] = b"n = 0\nwhile True:\n    n = n + 1\n"
    ws = Workspace(
        {"/data": ram}, mode=MountMode.EXEC, command_limits=_line(0.2)
    )
    start = time.monotonic()
    r = await ws.shell("python3 /data/spin.py")
    assert r.exit_code == 124
    assert "line: timed out after 0.2s" in (await r.stderr_str())
    # Cancellation halts the interpreter: the answer comes at the
    # deadline and the run does not linger as a burning thread (a leak
    # would hang pytest at loop shutdown).
    assert time.monotonic() - start < 5
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "wc /big",
        "grep -c line /big",
        "cat /big | wc",
        "cat -s /blank",
        "head -n -1000000 /blank",
        "uniq /blank",
        "tail -n 1 /blank",
    ],
)
async def test_large_ram_command_honors_caller_cancel(command):
    # Large enough that every command outlasts several yield slices: a
    # line starts eagerly, so one done within its first slice ends before
    # the cancel's timer can fire, and the cancel must land mid-run.

    ram = RAMVFS()
    ram.accessor.store.files["/big"] = b"line\n" * 2_000_000
    ram.accessor.store.files["/blank"] = b"\n" * 10_000_000
    ws = Workspace({"/": ram})
    cancel = asyncio.Event()
    loop = asyncio.get_running_loop()
    start = loop.time()
    fired: list[float] = []

    def stop() -> None:
        fired.append(loop.time() - start)
        cancel.set()

    timer = loop.call_later(0.005, stop)
    try:
        with pytest.raises(MirageAbortError):
            await ws.shell(command, cancel=cancel)
    finally:
        timer.cancel()
    assert fired[0] < 1


_UNCAPPED = {"@all": Limit(walk_limit=-1)}


def _wide_ram() -> RAMVFS:
    ram = RAMVFS()
    store = ram.accessor.store
    store.files["/big"] = b"line\n" * 20_000
    store.dirs.add("/wide")
    for d in range(100):
        store.dirs.add(f"/wide/d{d}")
        for f in range(200):
            store.files[f"/wide/d{d}/f{f}"] = b"x\n"
    return ram


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "find /wide -name nothing",
        "ls -lR /wide",
        "du -a /wide",
        "tree /wide",
        "grep -r nothing /wide",
        "rg nothing /wide",
        "cp -r /wide /copy",
        "chmod -R 700 /wide",
        "tar -cf /wide.tar /wide",
        "zip -qr /wide.zip /wide",
    ],
)
async def test_ram_walk_honors_caller_cancel(command):
    # A walk the index answers awaits coroutines that never suspend; the
    # dispatcher's task budget and the tree walk's budget let the cancel
    # land.

    ws = Workspace(
        {"/": (_wide_ram(), MountMode.WRITE, _UNCAPPED)}, mode=MountMode.WRITE
    )
    cancel = asyncio.Event()
    loop = asyncio.get_running_loop()
    timer = loop.call_later(0.005, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await ws.shell(command, cancel=cancel)
    finally:
        timer.cancel()
        await ws.close()


@pytest.mark.asyncio
async def test_every_program_settles_soon_after_a_cancel():
    # Every program the shell resolves, given a big file and a wide
    # directory, ends on its own or within a few seconds of the caller's
    # cancel, with room for a loaded runner. Each runs in a subshell, so
    # a `cd`, `set` or `exec` leaves the next one's shell as it was.

    ws = Workspace({"/": (_wide_ram(), MountMode.READ, _UNCAPPED)})
    loop = asyncio.get_running_loop()
    late: list[str] = []
    for name in programs(ws._call_session(), ws._registry):
        for operand in ("/big", "/wide"):
            cancel = asyncio.Event()
            fired: list[float] = []

            def stop() -> None:
                fired.append(loop.time())
                cancel.set()

            timer = loop.call_later(0.005, stop)
            try:
                await asyncio.wait_for(
                    ws.shell(f"( {name} {operand} )", cancel=cancel), 5
                )
            except MirageAbortError:
                pass
            except TimeoutError:
                late.append(f"{name} {operand}: still running after 5s")
                continue
            finally:
                timer.cancel()
            if fired and loop.time() - fired[0] > 3:
                late.append(
                    f"{name} {operand}: {loop.time() - fired[0]:.2f}s late"
                )
    await ws.close()
    assert late == []
