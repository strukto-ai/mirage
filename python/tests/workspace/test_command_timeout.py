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

import pytest

from mirage import MountMode, Workspace
from mirage.commands import safeguard as sg
from mirage.resource.ram import RAMResource
from mirage.types import CommandSafeguard, OnExceed


async def _slow_provision(*args, **kwargs):
    await asyncio.sleep(5)


@pytest.fixture
def restore_defaults():
    snapshot = dict(sg.DEFAULT_COMMAND_SAFEGUARDS)
    yield
    sg.DEFAULT_COMMAND_SAFEGUARDS.clear()
    sg.DEFAULT_COMMAND_SAFEGUARDS.update(snapshot)


def _ws(safeguards: dict | None = None) -> Workspace:
    if safeguards:
        return Workspace(
            {"/data": (RAMResource(), MountMode.WRITE, safeguards)},
            mode=MountMode.WRITE)
    return Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_quick_builtin_under_default_does_not_fire():
    ws = _ws()
    r = await ws.execute("echo hi")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "hi\n"


@pytest.mark.asyncio
async def test_builtin_default_safeguard_fires(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.1)
    ws = _ws()
    r = await ws.execute("sleep 2")
    assert r.exit_code == 124
    assert "sleep: timed out after 0.1s" in (await r.stderr_str())


@pytest.mark.asyncio
async def test_fallback_safeguard_applies_to_unknown_command(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.05)
    ws = _ws()
    r = await ws.execute("sleep 1")
    assert r.exit_code == 124


@pytest.mark.asyncio
async def test_pipeline_first_stage_to_trip_wins(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.1)
    ws = _ws()
    r = await ws.execute("sleep 2 | echo done")
    assert r.exit_code == 124
    assert "sleep: timed out" in (await r.stderr_str())


@pytest.mark.asyncio
async def test_timeout_zero_disables(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0)
    ws = _ws()
    r = await ws.execute("sleep 0.1")
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_mount_override_threaded_via_constructor():
    overrides = {"cat": CommandSafeguard(timeout_seconds=42.0, max_lines=99)}
    ws = _ws(safeguards=overrides)
    mount = next(m for m in ws._registry._mounts if m.prefix == "/data/")
    assert mount.command_safeguards["cat"].timeout_seconds == 42.0
    assert mount.command_safeguards["cat"].max_lines == 99


@pytest.mark.asyncio
async def test_mount_override_beats_command_default():
    overrides = {"cat": CommandSafeguard(timeout_seconds=999.0)}
    ws = _ws(safeguards=overrides)
    mount = next(m for m in ws._registry._mounts if m.prefix == "/data/")
    from mirage.commands.safeguard import resolve_safeguard
    resolved = resolve_safeguard("cat", None,
                                 mount.command_safeguards.get("cat"))
    assert resolved.timeout_seconds == 999.0


@pytest.mark.asyncio
async def test_timeout_sets_shared_cancel_event(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.05)
    ws = _ws()
    cancel = asyncio.Event()
    r = await ws.execute("sleep 1", cancel=cancel)
    assert r.exit_code == 124
    assert cancel.is_set()


@pytest.mark.asyncio
async def test_cross_mount_cat_honors_command_default_safeguard(
        restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["cat"] = CommandSafeguard(max_lines=4)
    a = RAMResource()
    b = RAMResource()
    a._store.dirs.add("/")
    b._store.dirs.add("/")
    a._store.files["/x.txt"] = b"a\n" * 20
    b._store.files["/y.txt"] = b"b\n" * 20
    ws = Workspace({"/a/": a, "/b/": b}, mode=MountMode.WRITE)
    r = await ws.execute("cat /a/x.txt /b/y.txt")
    out = await r.stdout_str()
    err = await r.stderr_str()
    assert out.count("\n") == 4
    assert "output truncated" in err


@pytest.mark.asyncio
async def test_fan_out_find_has_safeguard_set():
    a = RAMResource()
    a._store.dirs.add("/")
    a._store.files["/x.txt"] = b"hi\n"
    ws = Workspace({"/a/": a}, mode=MountMode.WRITE)
    r = await ws.execute("find /")
    assert r.safeguard is not None
    assert r.safeguard.timeout_seconds is not None


@pytest.mark.asyncio
async def test_cross_mount_honors_per_mount_timeout_override():
    a = RAMResource()
    b = RAMResource()
    a._store.dirs.add("/")
    b._store.dirs.add("/")
    a._store.files["/x.txt"] = b"hi\n"
    b._store.files["/y.txt"] = b"yo\n"
    ws = Workspace(
        {
            "/a/": (a, MountMode.WRITE, {
                "cat": CommandSafeguard(timeout_seconds=3.0)
            }),
            "/b/":
            b,
        },
        mode=MountMode.WRITE)
    r = await ws.execute("cat /a/x.txt /b/y.txt")
    assert r.safeguard is not None
    assert r.safeguard.timeout_seconds == 3.0


@pytest.mark.asyncio
async def test_fan_out_uses_tightest_timeout_among_mounts():
    parent = RAMResource()
    child = RAMResource()
    parent._store.dirs.add("/")
    parent._store.files["/a.txt"] = b"hi\n"
    child._store.dirs.add("/")
    child._store.files["/b.txt"] = b"yo\n"
    ws = Workspace(
        {
            "/p/":
            parent,
            "/p/sub/": (child, MountMode.WRITE, {
                "find": CommandSafeguard(timeout_seconds=2.0)
            }),
        },
        mode=MountMode.WRITE)
    r = await ws.execute("find /p")
    assert r.safeguard is not None
    assert r.safeguard.timeout_seconds == 2.0


@pytest.mark.asyncio
async def test_fan_out_tightest_when_parent_is_tighter():
    parent = RAMResource()
    child = RAMResource()
    parent._store.dirs.add("/")
    parent._store.files["/a.txt"] = b"hi\n"
    child._store.dirs.add("/")
    child._store.files["/b.txt"] = b"yo\n"
    ws = Workspace(
        {
            "/p/": (parent, MountMode.WRITE, {
                "find": CommandSafeguard(timeout_seconds=2.0)
            }),
            "/p/sub/": (child, MountMode.WRITE, {
                "find": CommandSafeguard(timeout_seconds=9.0)
            }),
        },
        mode=MountMode.WRITE)
    r = await ws.execute("find /p")
    assert r.safeguard is not None
    assert r.safeguard.timeout_seconds == 2.0


@pytest.mark.asyncio
async def test_background_job_propagates_timeout(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.05)
    ws = _ws()
    r1 = await ws.execute("sleep 2 &")
    assert r1.exit_code == 0
    r2 = await ws.execute("wait %1")
    assert r2.exit_code == 124
    err = await r2.stderr_str()
    assert "sleep: timed out" in err


@pytest.mark.asyncio
async def test_stderr_redirect_does_not_swallow_timeout_exit(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.05)
    ws = _ws()
    r = await ws.execute("sleep 2 2>&1")
    assert r.exit_code == 124
    r = await ws.execute("sleep 2 2>&1 | cat")
    assert r.exit_code == 124


@pytest.mark.asyncio
async def test_job_table_reports_completed_bg_without_wait(restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.05)
    ws = _ws()
    await ws.execute("sleep 5 &")
    await asyncio.sleep(0.2)
    jobs = ws.job_table.list_jobs()
    assert len(jobs) == 1
    assert jobs[0].status.value == "completed"
    assert jobs[0].exit_code == 124
    assert b"sleep: timed out" in jobs[0].stderr


@pytest.mark.asyncio
async def test_timeout_wrap_preserves_lazy_nonzero_exit_on_no_match():
    ws = _ws()
    await ws.execute("echo hello > /data/f.txt")
    r = await ws.execute("grep zzz /data/f.txt")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_timeout_wrap_preserves_lazy_zero_exit_on_match():
    ws = _ws()
    await ws.execute("echo hello > /data/f.txt")
    r = await ws.execute("grep hello /data/f.txt")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "hello\n"


@pytest.mark.asyncio
async def test_truncation_keeps_lazy_exit_zero_on_match():
    ws = _ws({"grep": CommandSafeguard(max_lines=2, timeout_seconds=600)})
    await ws.execute("printf 'a\\na\\na\\na\\n' > /data/f.txt")
    r = await ws.execute("grep a /data/f.txt")
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "a\na\n"


@pytest.mark.asyncio
async def test_provision_dry_run_honors_timeout(monkeypatch, restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["cat"] = CommandSafeguard(
        timeout_seconds=0.1)
    monkeypatch.setattr("mirage.workspace.workspace.provision_node",
                        _slow_provision)
    ws = _ws()
    r = await ws.execute("cat /data/f.txt", provision=True)
    assert r.exit_code == 124


@pytest.mark.asyncio
async def test_timeout_preserves_partial_records_and_logs(
        caplog, restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["sleep"] = CommandSafeguard(
        timeout_seconds=0.1)
    ws = _ws()
    await ws.execute("echo hello > /data/f.txt")
    before = len(ws._ops.records)
    with caplog.at_level(logging.DEBUG, logger="mirage.workspace.workspace"):
        r = await ws.execute("cat /data/f.txt; sleep 5")
    assert r.exit_code == 124
    assert len(ws._ops.records) > before
    assert any("timed out" in m for m in caplog.messages)


@pytest.mark.asyncio
async def test_cross_mount_cat_aggregates_tightest_safeguard():
    a = RAMResource()
    b = RAMResource()
    a._store.dirs.add("/")
    b._store.dirs.add("/")
    a._store.files["/x.txt"] = b"1\n2\n3\n"
    b._store.files["/y.txt"] = b"4\n5\n6\n"
    ws = Workspace(
        {
            "/a/": (a, MountMode.WRITE, {
                "cat":
                CommandSafeguard(max_lines=100, on_exceed=OnExceed.TRUNCATE)
            }),
            "/b/":
            (b, MountMode.WRITE, {
                "cat": CommandSafeguard(max_lines=1, on_exceed=OnExceed.ERROR)
            }),
        },
        mode=MountMode.WRITE)
    r = await ws.execute("cat /a/x.txt /b/y.txt")
    assert r.safeguard.max_lines == 1
    assert r.safeguard.on_exceed is OnExceed.ERROR


@pytest.mark.asyncio
async def test_python3_default_safeguard_fires_like_any_command(
        restore_defaults):
    sg.DEFAULT_COMMAND_SAFEGUARDS["python3"] = CommandSafeguard(
        timeout_seconds=0.2)
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   python_runtime="local")
    r = await ws.execute('python3 -c "import time; time.sleep(5)"')
    assert r.exit_code == 124
    assert "python3: timed out after 0.2s" in (await r.stderr_str())
    await ws.close()


@pytest.mark.asyncio
async def test_python3_mount_safeguard_fires_like_any_command(
        restore_defaults):
    ws = Workspace(
        {
            "/data": (RAMResource(), MountMode.EXEC, {
                "python3": CommandSafeguard(timeout_seconds=0.2)
            })
        },
        mode=MountMode.EXEC,
        python_runtime="local")
    r = await ws.execute('cd /data && python3 -c "import time; time.sleep(5)"')
    assert r.exit_code == 124
    assert "python3: timed out after 0.2s" in (await r.stderr_str())
    await ws.close()
