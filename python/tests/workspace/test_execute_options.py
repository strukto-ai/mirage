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
from mirage.resource.ram import RAMResource


def _make_ws():
    resource = RAMResource()
    store = resource._store
    store.dirs.add("/")
    store.dirs.add("/subdir")
    store.dirs.add("/other")
    store.files["/subdir/file.txt"] = b"hello"
    store.modified["/subdir/file.txt"] = "2024-01-01"
    return Workspace({"/ram/": resource}, mode=MountMode.WRITE)


# ── cwd tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cwd_runs_in_override():
    ws = _make_ws()
    r = await ws.execute("pwd", cwd="/ram/subdir")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_cwd_does_not_mutate_session():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    await ws.execute("pwd", cwd="/ram/subdir")
    after = ws.get_session(ws.default_session_id).cwd
    assert before == after


@pytest.mark.asyncio
async def test_cwd_cd_does_not_leak():
    ws = _make_ws()
    before = ws.get_session(ws.default_session_id).cwd
    await ws.execute("cd /ram/subdir", cwd="/ram")
    after = ws.get_session(ws.default_session_id).cwd
    assert before == after


@pytest.mark.asyncio
async def test_cwd_parallel_isolation():
    ws = _make_ws()
    r1, r2 = await asyncio.gather(
        ws.execute("pwd", cwd="/ram/subdir"),
        ws.execute("pwd", cwd="/ram/other"),
    )
    assert (await r1.stdout_str()).strip() == "/ram/subdir"
    assert (await r2.stdout_str()).strip() == "/ram/other"


@pytest.mark.asyncio
async def test_setup_persists_overrides_inherit():
    ws = _make_ws()
    await ws.execute("export DEBUG=1")
    assert ws.get_session(ws.default_session_id).env.get("DEBUG") == "1"
    before_cwd = ws.get_session(ws.default_session_id).cwd
    r = await ws.execute("printenv DEBUG", cwd="/ram/subdir")
    assert (await r.stdout_str()).strip() == "1"
    assert ws.get_session(ws.default_session_id).cwd == before_cwd
    assert ws.get_session(ws.default_session_id).env.get("DEBUG") == "1"


@pytest.mark.asyncio
async def test_function_definitions_do_not_leak():
    ws = _make_ws()
    await ws.execute("greet() { echo hi; }", cwd="/ram/subdir")
    session = ws.get_session(ws.default_session_id)
    assert "greet" not in session.functions


# ── env tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_env_exposes_override():
    ws = _make_ws()
    r = await ws.execute("printenv FOO", env={"FOO": "bar"})
    assert r.exit_code == 0
    assert (await r.stdout_str()).strip() == "bar"


@pytest.mark.asyncio
async def test_env_does_not_mutate_session():
    ws = _make_ws()
    before = dict(ws.get_session(ws.default_session_id).env)
    await ws.execute("printenv FOO", env={"FOO": "bar"})
    after = dict(ws.get_session(ws.default_session_id).env)
    assert before == after


@pytest.mark.asyncio
async def test_env_export_does_not_leak():
    ws = _make_ws()
    await ws.execute("export LEAKED=yes", env={"FOO": "bar"})
    assert "LEAKED" not in ws.get_session(ws.default_session_id).env


@pytest.mark.asyncio
async def test_env_layers_onto_session():
    ws = _make_ws()
    await ws.execute("export BASE=keep")
    assert ws.get_session(ws.default_session_id).env.get("BASE") == "keep"
    r_base = await ws.execute("printenv BASE", env={"FOO": "bar"})
    assert (await r_base.stdout_str()).strip() == "keep"
    r_foo = await ws.execute("printenv FOO", env={"FOO": "bar"})
    assert (await r_foo.stdout_str()).strip() == "bar"
    session_env = ws.get_session(ws.default_session_id).env
    assert session_env.get("BASE") == "keep"
    assert "FOO" not in session_env


@pytest.mark.asyncio
async def test_env_parallel_isolation():
    ws = _make_ws()
    r1, r2 = await asyncio.gather(
        ws.execute("printenv FOO", env={"FOO": "one"}),
        ws.execute("printenv FOO", env={"FOO": "two"}),
    )
    assert (await r1.stdout_str()).strip() == "one"
    assert (await r2.stdout_str()).strip() == "two"


# ── mid-flight cancel ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cancel_pre_set_raises_immediately():
    ws = _make_ws()
    cancel = asyncio.Event()
    cancel.set()
    with pytest.raises(Exception) as exc_info:
        await ws.execute("echo hi", cancel=cancel)
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
        await ws.execute("sleep 5", cancel=cancel)
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
        await ws.execute(
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
        await ws.execute(
            "sleep 1 && sleep 1 && sleep 1 && echo done",
            cancel=cancel,
        )
    assert asyncio.get_event_loop().time() - t0 < 2.0


@pytest.mark.asyncio
async def test_cancel_inside_command_substitution():
    ws = _make_ws()
    cancel = asyncio.Event()

    async def trigger() -> None:
        await asyncio.sleep(0.1)
        cancel.set()

    asyncio.create_task(trigger())
    t0 = asyncio.get_event_loop().time()
    with pytest.raises(Exception):
        await ws.execute('echo "$(sleep 5)"', cancel=cancel)
    assert asyncio.get_event_loop().time() - t0 < 1.0


@pytest.mark.asyncio
async def test_cancel_workspace_remains_usable():
    ws = _make_ws()
    cancel = asyncio.Event()

    async def trigger() -> None:
        await asyncio.sleep(0.05)
        cancel.set()

    asyncio.create_task(trigger())
    with pytest.raises(Exception):
        await ws.execute("sleep 5", cancel=cancel)
    r = await ws.execute("echo recovered")
    assert r.exit_code == 0
    assert r.stdout.decode().strip() == "recovered"


# ── agent harness pattern ─────────────────────────────────────────


async def _tool_call(ws, cmd, cwd_v, env_v, timeout):
    cancel = asyncio.Event()
    asyncio.get_event_loop().call_later(timeout, cancel.set)
    return await ws.execute(cmd, cwd=cwd_v, env=env_v, cancel=cancel)


@pytest.mark.asyncio
async def test_agent_pattern_parallel_tool_calls_each_with_own_options():
    ws = _make_ws()
    a, b = await asyncio.gather(
        _tool_call(ws, "pwd; printenv DEBUG", "/ram/subdir", {"DEBUG": "one"},
                   5.0),
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
    resource = RAMResource()
    resource._store.dirs.add("/")
    ws = Workspace({"/ram/": resource},
                   mode=MountMode.WRITE,
                   session_id="mysess")
    r = await ws.execute("echo hi > /ram/f.txt")
    assert r.exit_code == 0
    r2 = await ws.execute("cat /ram/f.txt")
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
