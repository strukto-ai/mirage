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
from mirage.commands.registry import command
from mirage.commands.spec import CommandSpec
from mirage.io.types import IOResult
from mirage.observe.store import RAMObserverStore
from mirage.policy import Action, CommandContext, Deny, Policy
from mirage.resource.ram import RAMResource
from mirage.workspace.abort import ABORT_JOIN_SECONDS, MirageAbortError
from mirage.workspace.session.ram import RAMSessionStore
from mirage.workspace.session.store import SessionFields


class _StalledSessionStore(RAMSessionStore):

    async def load(self) -> dict[str, SessionFields]:
        await asyncio.Event().wait()
        return {}


class _StallableSessionStore(RAMSessionStore):

    def __init__(self) -> None:
        super().__init__()
        self.stall = False

    async def cas_set(self, session_id, fields, expected_generation):
        if self.stall:
            await asyncio.Event().wait()
        return await super().cas_set(session_id, fields, expected_generation)


class _StalledObserverStore(RAMObserverStore):

    async def append(self, path, data) -> None:
        await asyncio.Event().wait()


def _register(ws: Workspace, prefix: str, fn) -> None:
    mount = ws._registry.mount_for(prefix)
    for registered in fn._registered_commands:
        mount.register(registered)


def _make_ws() -> Workspace:
    resource = RAMResource()
    store = resource._store
    store.dirs.add("/")
    store.dirs.add("/subdir")
    store.dirs.add("/other")
    return Workspace({"/ram/": resource}, mode=MountMode.WRITE)


def _two_mounts() -> Workspace:
    a = RAMResource()
    a._store.dirs.add("/")
    b = RAMResource()
    b._store.dirs.add("/")
    b._store.files["/y.txt"] = b"secret\n"
    return Workspace(
        {
            "/a": (a, MountMode.WRITE),
            "/b": (b, MountMode.WRITE)
        },
        mode=MountMode.WRITE,
    )


# A nested eval ($(), eval, source, xargs) re-enters execute and must
# continue in the LIVE session the outer line runs in. An id cannot say
# that: it names a registered session, never the ephemeral per-call
# fork, so these pin the fork cases that only the ambient session
# context can answer.


@pytest.mark.asyncio
async def test_cmdsub_reads_the_per_call_forks_cwd():
    ws = _make_ws()
    r = await ws.execute("echo $(pwd)", cwd="/ram/subdir")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_eval_moves_the_fork_not_the_default_session():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    r = await ws.execute("eval 'cd /ram/other'; pwd", cwd="/ram/subdir")
    assert (await r.stdout_str()).strip() == "/ram/other"
    assert ws.get_session(ws.default_session_id).cwd == before


@pytest.mark.asyncio
async def test_cmdsub_cd_stays_in_the_fork():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    await ws.execute("echo $(cd /ram/other)", env={"FOO": "bar"})
    assert ws.get_session(ws.default_session_id).cwd == before


@pytest.mark.asyncio
async def test_cmdsub_reads_the_named_sessions_cwd():
    ws = _make_ws()
    ws.create_session("agent")
    await ws.execute("cd /ram/subdir", session_id="agent")
    r = await ws.execute("echo $(pwd)", session_id="agent")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_cmdsub_keeps_the_named_sessions_hides():
    # A nested eval runs under the same session, so what the profile hides
    # is as absent inside `$()` as outside it.
    ws = _two_mounts()
    ws.create_session("agent", profile={"paths": {"hide": ["/b"]}})
    r = await ws.execute("echo $(cat /b/y.txt)", session_id="agent")
    assert "secret" not in (await r.stdout_str())


@pytest.mark.asyncio
async def test_cmdsub_cd_is_isolated_from_the_live_session():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    io = await ws.execute("echo $(cd /ram/subdir; pwd)")
    assert await io.stdout_str() == "/ram/subdir\n"
    assert ws.get_session(ws.default_session_id).cwd == before


# A background job forks the session, so it is the one mid-line point
# where the ambient session must be rebound: without that, a nested
# eval inside `... &` resolves the OUTER live session (the fork keeps
# its parent's id) and escapes the job's isolation.


@pytest.mark.asyncio
async def test_bg_job_cmdsub_reads_the_jobs_fork():
    ws = _make_ws()
    r = await ws.execute("cd /ram/other && echo $(pwd) & wait %1")
    assert (await r.stdout_str()).strip() == "/ram/other"


@pytest.mark.asyncio
async def test_bg_job_cmdsub_cd_stays_in_the_jobs_fork():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    await ws.execute("echo $(cd /ram/other) & wait %1")
    assert ws.get_session(ws.default_session_id).cwd == before


# $() must run its whole body: bash substitutes the output of the full
# statement list, not of the first simple command it contains.


@pytest.mark.asyncio
async def test_cmdsub_runs_every_statement():
    ws = _make_ws()
    r = await ws.execute("echo $(echo a; echo b)")
    assert (await r.stdout_str()).strip() == "a b"


@pytest.mark.asyncio
async def test_cmdsub_runs_control_flow():
    ws = _make_ws()
    r = await ws.execute("echo $(if true; then echo yes; fi)")
    assert (await r.stdout_str()).strip() == "yes"


@pytest.mark.asyncio
async def test_cmdsub_runs_assignments():
    ws = _make_ws()
    r = await ws.execute("echo $(X=5; echo $X)")
    assert (await r.stdout_str()).strip() == "5"


@pytest.mark.asyncio
async def test_cmdsub_runs_declarations():
    ws = _make_ws()
    r = await ws.execute("echo $(export Y=7; echo $Y)")
    assert (await r.stdout_str()).strip() == "7"


# The ambient session belongs to the workspace that published it. A
# callback fired mid-line reaching a SECOND workspace must not adopt
# it: that workspace's own session owns its cwd, env and mount grants,
# and an unrestricted session must never stand in for a restricted one.


@pytest.mark.asyncio
async def test_another_workspace_resolves_its_own_session():
    ws_a = _make_ws()
    ws_b = _two_mounts()
    seen: list[str] = []

    @command("crossprobe", resource="ram", spec=CommandSpec())
    async def crossprobe(accessor, paths, texts, opts):
        result = await ws_b.execute("pwd")
        seen.append((await result.stdout_str()).strip())
        return b"", IOResult()

    _register(ws_a, "/ram/", crossprobe)
    await ws_a.execute("crossprobe", cwd="/ram/subdir")
    assert seen == ["/"]


@pytest.mark.asyncio
async def test_policy_reads_the_ambient_sessions_cwd():
    # The policy decides about the line the session actually runs, so
    # it reads the resolved session's cwd, not the registered
    # session's: a re-entrant line runs in the live ambient fork.
    seen: list[str] = []

    def policy(ctx):
        seen.append(ctx.cwd)
        return None

    resource = RAMResource()
    store = resource._store
    store.dirs.add("/")
    store.dirs.add("/subdir")
    ws = Workspace({"/ram/": resource},
                   mode=MountMode.WRITE,
                   route_policy=policy)

    @command("policyprobe", resource="ram", spec=CommandSpec())
    async def policyprobe(accessor, paths, texts, opts):
        await ws.execute("pwd")
        return b"", IOResult()

    _register(ws, "/ram/", policyprobe)
    await ws.execute("policyprobe", cwd="/ram/subdir")
    assert seen == ["/ram/subdir", "/ram/subdir"]


class _DenySecret(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "echo" and "secret" in ctx.argv:
            return Deny(reason="secrets stay put")
        return None


def _policed_ws() -> Workspace:
    resource = RAMResource()
    resource._store.dirs.add("/")
    return Workspace({"/ram/": resource},
                     mode=MountMode.WRITE,
                     policies=[_DenySecret()])


# A nested line ($(), eval, `command NAME`) re-enters execute; the
# refusal it earns has to reach the outer line's result, or the line
# says `Permission denied` beside no record.
@pytest.mark.asyncio
async def test_command_name_keeps_the_record_the_inner_line_earned():
    ws = _policed_ws()
    io = await ws.execute('V=secret; command echo "$V"')
    assert io.exit_code == 126
    assert io.stderr == b"echo: Permission denied\n"
    assert io.refusal is not None
    assert io.refusal.reason == "secrets stay put"


@pytest.mark.asyncio
async def test_eval_keeps_the_record_the_inner_line_earned():
    ws = _policed_ws()
    io = await ws.execute('V=secret; eval "echo $V"')
    assert io.exit_code == 126
    assert io.refusal is not None
    assert io.refusal.reason == "secrets stay put"


# A substitution keeps only the inner stdout, so its record has to
# reach the line through the door every nested line re-enters by.
@pytest.mark.asyncio
async def test_a_substitution_keeps_the_record_the_inner_line_earned():
    ws = _policed_ws()
    io = await ws.execute('V=secret; X=$(echo "$V")')
    assert io.exit_code == 126
    assert io.refusal is not None
    assert io.refusal.reason == "secrets stay put"


@pytest.mark.asyncio
async def test_an_unrefused_outer_command_still_reports_the_inner_record():
    ws = _policed_ws()
    io = await ws.execute('V=secret; echo "[$(echo "$V")]"')
    assert io.exit_code == 0
    assert io.stdout == b"[]\n"
    assert io.refusal is not None
    assert io.refusal.reason == "secrets stay put"


# `!` negates the status, so a refused command reads as success (bash
# does the same for a command it may not run); the record of what was
# refused still has to ride the result.
@pytest.mark.asyncio
async def test_a_negated_command_keeps_its_refusal():
    ws = _policed_ws()
    io = await ws.execute('V=secret; ! echo "$V"')
    assert io.exit_code == 0
    assert io.stderr == b"echo: Permission denied\n"
    assert io.refusal is not None
    assert io.refusal.reason == "secrets stay put"


@pytest.mark.asyncio
async def test_a_negated_pipeline_keeps_its_refusal():
    ws = _policed_ws()
    io = await ws.execute('V=secret; ! true | echo "$V"')
    assert io.exit_code == 0
    assert io.refusal is not None
    assert io.refusal.reason == "secrets stay put"


@pytest.mark.asyncio
async def test_cancel_releases_a_line_stalled_before_it_runs():
    # The session store never answers its load, so the line is stuck
    # before its first gate; the caller's event still has to release it.
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   session_store=_StalledSessionStore())
    cancel = asyncio.Event()
    timer = asyncio.get_running_loop().call_later(0.05, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await ws.execute("echo hi", cancel=cancel)
    finally:
        timer.cancel()


@pytest.mark.asyncio
async def test_abort_during_preflight_is_not_recorded():
    # A line is recorded once it has been parsed; one that never got past
    # the loading of workspace state leaves no history entry, as in
    # TypeScript.
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   session_store=_StalledSessionStore())
    cancel = asyncio.Event()
    timer = asyncio.get_running_loop().call_later(0.05, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await ws.execute("echo hi", cancel=cancel)
    finally:
        timer.cancel()
    assert await ws.observer.command_events() == []


@pytest.mark.asyncio
async def test_abort_on_the_flush_restores_status():
    # The line stamped its status and then its flush never settles: the
    # caller gets the abort, `$?` is what the line found, and the next
    # line flushes normally because the cancelled write kept the
    # generation the store knows.
    store = _StallableSessionStore()
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   session_store=store)
    await ws.execute("false")
    session = ws._session_mgr.get(ws._session_mgr.default_id)
    store.stall = True
    cancel = asyncio.Event()
    timer = asyncio.get_running_loop().call_later(0.05, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await ws.execute("export MARK=1", cancel=cancel)
    finally:
        timer.cancel()
    assert session.last_exit_code == 1
    store.stall = False
    r = await ws.execute("echo next")
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_abort_on_the_history_record_restores_status():
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   observe=_StalledObserverStore())
    session = ws._session_mgr.get(ws._session_mgr.default_id)
    session.last_exit_code = 7
    cancel = asyncio.Event()
    timer = asyncio.get_running_loop().call_later(0.05, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await ws.execute("echo hi", cancel=cancel)
    finally:
        timer.cancel()
    assert session.last_exit_code == 7


@pytest.mark.asyncio
async def test_abort_of_a_running_line_is_not_held_by_a_dead_history_store():
    # The cancel lands on the body (`sleep`), and the line's finally then
    # records into a store that never answers. The caller is released
    # after the grace all the same, with the abort and `$?` restored.
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   observe=_StalledObserverStore())
    session = ws._session_mgr.get(ws._session_mgr.default_id)
    session.last_exit_code = 7
    cancel = asyncio.Event()
    timer = asyncio.get_running_loop().call_later(0.05, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await asyncio.wait_for(ws.execute("sleep 5", cancel=cancel), 2)
    finally:
        timer.cancel()
    assert session.last_exit_code == 7


@pytest.mark.asyncio
async def test_a_wait_for_timeout_is_not_held_by_a_dead_history_store():
    # The event is never set: the caller is cancelled from outside, by a
    # wait_for. The line still gets both cancels and the grace between
    # them, so the dead store does not hold the caller, and `$?` is what
    # the line found rather than what it stamped.
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   observe=_StalledObserverStore())
    session = ws._session_mgr.get(ws._session_mgr.default_id)
    session.last_exit_code = 7
    started = asyncio.get_running_loop().time()
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            ws.execute("false; echo hi", cancel=asyncio.Event()), 0.05)
    elapsed = asyncio.get_running_loop().time() - started
    assert elapsed < ABORT_JOIN_SECONDS + 1
    assert session.last_exit_code == 7


@pytest.mark.asyncio
async def test_abort_of_a_running_line_is_not_held_by_a_dead_session_store():
    store = _StallableSessionStore()
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   session_store=store)
    await ws.execute("false")
    session = ws._session_mgr.get(ws._session_mgr.default_id)
    store.stall = True
    cancel = asyncio.Event()
    timer = asyncio.get_running_loop().call_later(0.05, cancel.set)
    try:
        with pytest.raises(MirageAbortError):
            await asyncio.wait_for(
                ws.execute("export MARK=1; sleep 5", cancel=cancel), 2)
    finally:
        timer.cancel()
    assert session.last_exit_code == 1
