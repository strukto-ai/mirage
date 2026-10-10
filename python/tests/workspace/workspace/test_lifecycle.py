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
import errno
import io
import os
import threading
from fnmatch import fnmatchcase
from uuid import uuid4

import pytest

from mirage.cache.index.config import (
    IndexConfig,
    IndexEntry,
    LookupStatus,
    RedisIndexConfig,
)
from mirage.cache.index.view import IndexView
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import Command
from mirage.commands.spec import Argument, CommandSpec
from mirage.io import IOResult
from mirage.runtime.base import Runtime
from mirage.shell.console import (
    Channel,
    ConsoleChunk,
    JobConsole,
    RAMConsoleStore,
)
from mirage.shell.job_table import JobStatus
from mirage.types import CapacityResult, CapacityState, MountMode, PathSpec
from mirage.utils.abort import MirageAbortError
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.vfs.call import vfs_call
from mirage.vfs.ram import RAMVFS
from mirage.vfs.types import Effect
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.shared import expand_operands
from mirage.workspace.executor.command.run import drop_mount_caches
from mirage.workspace.mount.namespace import RAMNamespaceStore
from mirage.workspace.mount.spec import Mount
from mirage.workspace.snapshot import to_state_dict
from mirage.workspace.types import ExecutionNode
from tests.fixtures.vfs_io import override, override_glob

_RELEASE: list[asyncio.Event] = []


@pytest.mark.asyncio
async def test_close_keeps_loop_responsive_while_kernel_unmount_blocks(
    monkeypatch,
):
    entered, release = threading.Event(), threading.Event()
    ws = Workspace({})

    def unmount():
        entered.set()
        assert release.wait(2)

    monkeypatch.setattr(ws._kernel_mounts, "close", unmount)
    closing = asyncio.create_task(ws.close())
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        await asyncio.sleep(0)
        assert not closing.done()
    finally:
        release.set()
        await closing


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action",
    ["glob", "midpath", "metadata", "touch", "chmod", "chown", "chgrp"],
)
async def test_first_mount_access_prepares_expansion(action):
    ancestor = RAMVFS()
    ws = Workspace({"/": ancestor}, index=IndexConfig(ttl=600))
    shared = ws.mount("/").index_store
    replacement = RAMVFS()
    replacement.load_state(
        {
            "dirs": ["/", "/dir"],
            "files": {
                "/fresh.txt": b"new",
                "/dir/fresh.txt": b"new",
                "/file": b"new",
            },
        }
    )
    directory = "/data/dir" if action == "midpath" else "/data"
    await shared.set_dir(
        directory,
        [
            (
                "stale.txt",
                IndexEntry(id="old", name="stale.txt", resource_type="file"),
            )
        ],
    )
    ws.add_mount("/data", replacement, MountMode.WRITE)
    mount = ws.mount("/data")
    walk = mount._glob

    async def glob(accessor, path, *, index=None, **kwargs):
        # The listing the ancestor's mount recorded for this directory,
        # which must not be served stale here.
        listing = await shared.list_dir(path.directory.rstrip("/") or "/")
        if listing.entries is not None:
            prefix = mount_prefix_of(path.virtual, path.vfs_path)
            return [
                PathSpec.from_str_path(key, mount_key(key, prefix))
                for key in listing.entries
                if fnmatchcase(key.rsplit("/", 1)[-1], path.pattern or "*")
            ]
        return await walk(path, index=index)

    override_glob(mount, glob)
    try:
        if action == "metadata":
            expanded = await expand_operands(
                ws._namespace,
                [
                    PathSpec(
                        virtual="/data/*.txt",
                        directory="/data/",
                        vfs_path="*.txt",
                        pattern="*.txt",
                        resolved=False,
                    )
                ],
            )
            assert [p.virtual for p in expanded] == ["/data/fresh.txt"]
        elif action in {"touch", "chmod", "chown", "chgrp"}:
            command = {
                "touch": "touch",
                "chmod": "chmod 600",
                "chown": "chown 123",
                "chgrp": "chgrp 456",
            }[action]
            result = await ws.shell(command + " /data/*.txt")
            assert result.exit_code == 0, result.stderr
            assert (
                await ws.shell("echo /data/*.txt")
            ).stdout == b"/data/fresh.txt\n"
        else:
            pattern = "/data/*/*.txt" if action == "midpath" else "/data/*.txt"
            result = await ws.shell("echo " + pattern)
            assert result.stdout == f"{directory}/fresh.txt\n".encode()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_unmount_waits_for_an_inflight_cache_write(monkeypatch):
    class CachedRAM(RAMVFS):
        caches_reads = True

    old = CachedRAM()
    old.load_state({"files": {"/file": b"old"}})
    ws = Workspace({"/data": old})
    entered = asyncio.Event()
    release = asyncio.Event()
    write_cache = ws.cache.set

    async def blocked_set(*args, **kwargs):
        entered.set()
        await release.wait()
        await write_cache(*args, **kwargs)

    monkeypatch.setattr(ws.cache, "set", blocked_set)
    reading = asyncio.create_task(ws.shell("cat /data/file"))
    removing = None
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        removing = asyncio.create_task(ws.unmount("/data"))
        await asyncio.sleep(0)
        assert not removing.done()
        with pytest.raises(ValueError, match="duplicate mount prefix"):
            ws.add_mount("/data", CachedRAM())
        release.set()
        await asyncio.wait_for(asyncio.gather(reading, removing), timeout=5)
        assert await ws.cache.get("/data/file") is None
        replacement = CachedRAM()
        replacement.load_state({"files": {"/file": b"new"}})
        ws.add_mount("/data", replacement)
        assert (await ws.shell("cat /data/file")).stdout == b"new"
    finally:
        release.set()
        await asyncio.gather(
            reading, *([removing] if removing else []), return_exceptions=True
        )
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_vfs_cannot_be_remounted_while_close_is_pending(
    monkeypatch, cancel
):
    vfs = RAMVFS()
    ws = Workspace({"/data": vfs})
    entered = asyncio.Event()
    release = asyncio.Event()
    closed = asyncio.Event()
    close = vfs.close

    async def blocked_close():
        entered.set()
        await release.wait()
        await close()
        closed.set()

    monkeypatch.setattr(vfs, "close", blocked_close)
    removing = asyncio.create_task(ws.unmount("/data"))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        if cancel:
            removing.cancel()
            with pytest.raises(asyncio.CancelledError):
                await removing
        for prefix in ("/data", "/alias"):
            with pytest.raises(ValueError, match="VFS is being unmounted"):
                ws.add_mount(prefix, vfs)
        release.set()
        await asyncio.wait_for(closed.wait(), timeout=5)
        await asyncio.sleep(0)
        if not cancel:
            await removing
        with pytest.raises(ValueError, match="VFS is closed"):
            ws.add_mount("/data", vfs)
        with pytest.raises(ValueError, match="VFS is closed"):
            Workspace({"/data": vfs})
        ws.add_mount("/data", RAMVFS())
    finally:
        release.set()
        await asyncio.gather(removing, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["replace", "shadow", "reveal"])
async def test_retired_command_cannot_cache_bytes_for_replacement_mount(
    change,
):
    shadow = change == "shadow"

    class CachedRAM(RAMVFS):
        caches_reads = True

    old = CachedRAM()
    old.load_state({"files": {"/data/file" if shadow else "/file": b"old"}})
    replacement = CachedRAM()
    replacement.load_state(
        {"files": {"/data/file" if change == "reveal" else "/file": b"new"}}
    )
    entered = asyncio.Event()
    release = asyncio.Event()

    async def gate(_inv):
        entered.set()
        await release.wait()
        return None, IOResult()

    prefix = "/" if shadow else "/data"
    mounts = {prefix: old}
    if change == "reveal":
        mounts["/"] = replacement
    ws = Workspace(mounts)
    ws.register_cli(
        "gate",
        CLI(spec=CommandSpec(name="gate"), handlers={"": CLIHandler(fn=gate)}),
    )
    running = asyncio.create_task(ws.shell("cat /data/file; gate"))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        if not shadow:
            await ws.unmount("/data")
        if change != "reveal":
            ws.add_mount("/data", replacement)
        release.set()
        result = await asyncio.wait_for(running, timeout=5)
        assert result.stdout == b"old"
        assert (await ws.shell("cat /data/file")).stdout == b"new"
        assert await ws.cache.get("/data/file") == b"new"
    finally:
        release.set()
        await asyncio.gather(running, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_eviction", [False, True])
@pytest.mark.parametrize("cache_kind", ["file", "index"])
async def test_unmount_keeps_prefix_reserved_until_cache_cleanup(
    monkeypatch, fail_eviction, cache_kind
):
    vfs = RAMVFS()
    vfs.load_state({"files": {"/file": b"old"}})
    ws = Workspace({"/data": vfs}, mode=MountMode.WRITE)
    cache = ws.cache
    ws.add_mount("/alias", vfs)
    alias_entries = await ws.vfs.readdir("/alias")
    entered = asyncio.Event()
    release = asyncio.Event()
    store = cache if cache_kind == "file" else ws.mount("/data").index_store
    method = "evict_prefix" if cache_kind == "file" else "invalidate_prefix"
    evict = getattr(store, method)

    async def blocked_evict(prefix):
        entered.set()
        await release.wait()
        if fail_eviction:
            raise RuntimeError("cache unavailable")
        await evict(prefix)

    monkeypatch.setattr(store, method, blocked_evict)
    await cache.set("/data", b"root")
    await cache.set("/data/file", b"old")
    await cache.set("/database/file", b"peer")
    removing = asyncio.create_task(ws.unmount("data/"))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        await ws.mount("/alias").ensure_ready()
        with pytest.raises(ValueError, match="duplicate mount prefix"):
            ws.add_mount("/data", RAMVFS())
        with pytest.raises(OSError) as reading:
            await ws.vfs.readdir("/data")
        assert reading.value.errno == errno.EBUSY
        with pytest.raises(OSError) as writing:
            await ws.vfs.write("/data/file", b"changed")
        assert writing.value.errno == errno.EBUSY
        for line in ("cat /data/file", "echo changed > /data/file"):
            assert (await ws.shell(line)).exit_code != 0
        assert vfs.get_state()["files"]["/file"] == b"old"
        release.set()
        if fail_eviction:
            with pytest.raises(RuntimeError, match="cache unavailable"):
                await removing
            assert ws.mount("/data").vfs is vfs
            monkeypatch.setattr(store, method, evict)
            await ws.unmount("/data")
        else:
            await removing
        assert await cache.get("/data") is None
        assert await cache.get("/data/file") is None
        assert await cache.get("/database/file") == b"peer"
        assert await ws.vfs.readdir("/alias") == alias_entries
        ws.add_mount("/data", RAMVFS())
    finally:
        release.set()
        await asyncio.gather(removing, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("store_kind", ["ram", "redis"])
@pytest.mark.parametrize("shadow", [False, True])
async def test_mount_change_invalidates_index_before_replacement(
    store_kind, shadow
):
    config = IndexConfig()
    if store_kind == "redis":
        url = os.environ.get("REDIS_URL")
        if not url:
            pytest.skip("REDIS_URL not set")
        config = RedisIndexConfig(url=url, key_prefix=f"lifecycle:{uuid4()}:")
    vfs = RAMVFS()
    ws = Workspace({"/" if shadow else "/data": vfs}, index=config)
    ws.add_mount("/alias", vfs)
    index = ws.mount("/" if shadow else "/data").index_store
    entry = IndexEntry(id="old", name="private.txt", resource_type="file")
    try:
        await index.put("/data", entry)
        for path in ("/data", "/data/nested", "/database", "/alias"):
            await index.set_dir(path, [("private.txt", entry)])
        if not shadow:
            await ws.unmount("/data")
        ws.add_mount("/data", RAMVFS())
        if shadow:
            assert await ws.vfs.readdir("/data") == []
        for candidate in (index, ws.mount("/data").index_store):
            for path in (
                "/data",
                "/data/private.txt",
                "/data/nested/private.txt",
            ):
                assert (
                    await candidate.get(path)
                ).status == LookupStatus.NOT_FOUND
            for path in ("/data", "/data/nested"):
                assert (await candidate.list_dir(path)).entries in (None, [])
        for path in ("/database", "/alias"):
            assert (await index.list_dir(path)).entries == [
                f"{path}/private.txt"
            ]
    finally:
        await index.clear()
        await ws.close()


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)


async def _deaf_run(job):
    """A runner that swallows the cancel and keeps going.

    Deliberately not ``sleep``: that is the one command which consumes
    the signal, so it settles through its own runner and would pass even
    when teardown merely requests a cancel. Only settling in teardown
    ends this one.

    Args:
        job: the job being run, whose console proves it started.
    """
    await job.console.emit(Channel.STDOUT, b"partial")
    release = asyncio.Event()
    _RELEASE.append(release)
    try:
        await asyncio.sleep(30)
    except asyncio.CancelledError:
        await release.wait()
    return IOResult(exit_code=0), ExecutionNode(command="deaf", exit_code=0)


async def _submit_deaf(ws: Workspace):
    """Start a deaf job and return it once it is genuinely running.

    Args:
        ws (Workspace): workspace whose table receives the job.
    """
    job = ws.job_table.submit(command="deaf", run=_deaf_run, cwd="/")
    while not await job.console.snapshot(Channel.STDOUT):
        await asyncio.sleep(0)
    return job


@pytest.mark.asyncio
async def test_close_settles_a_job_that_ignores_the_cancel():
    """Teardown records the outcome, it does not only request a cancel.

    A bare cancel leaves the job RUNNING with no ending chunk, so anyone
    parked on ``wait_finished`` waits forever on a workspace that is
    already gone. The console ends promptly, while workspace teardown
    waits for the managed runner before closing its mounts.
    """
    _RELEASE.clear()
    ws = _workspace()
    job = await _submit_deaf(ws)
    try:
        closing = asyncio.create_task(ws.close())
        await asyncio.wait_for(job.console.wait_finished(), timeout=2)
        assert not closing.done()
        for release in _RELEASE:
            release.set()
        await asyncio.wait_for(closing, timeout=5)

        assert job.status == JobStatus.KILLED
        assert job.exit_code == 137
        await asyncio.wait_for(job.console.wait_finished(), timeout=2)
    finally:
        # Unconditional: a failed assertion above must still unblock the
        # runner, or the pending task turns a clean failure into a hang
        # at loop teardown.
        for release in _RELEASE:
            release.set()
        await asyncio.sleep(0)

    # The runner unwinding afterwards must not reopen or relabel it.
    assert job.status == JobStatus.KILLED


class _LateWriteStore(RAMConsoleStore):
    """A RAM console that records every write landing after close.

    A Redis console reconnects for such a write, and nothing closes that
    client again. ``gate`` holds writes back until the test opens it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()
        self.late: list[Channel] = []

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        await self.gate.wait()
        if self.closed:
            self.late.append(channel)
        return await super().append(channel, data)


@pytest.mark.asyncio
async def test_close_keeps_a_console_open_until_its_runner_settles():
    """A disowned job killed by pid settles in its own task.

    It writes its ending as it unwinds, and teardown must not close the
    console under those writes.
    """
    store = _LateWriteStore()
    started = asyncio.Event()

    async def run(job):
        started.set()
        await asyncio.sleep(30)

    ws = Workspace(
        {"/m": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        console_factory=lambda job_id: JobConsole(store),
    )
    job = ws.job_table.submit(command="sleep 30", run=run, cwd="/")
    await asyncio.wait_for(started.wait(), timeout=2)
    ws.job_table.disown(job.id)
    assert job.process is not None and job.process.terminate()

    async def killed():
        while job.status == JobStatus.RUNNING:
            await asyncio.sleep(0)

    await asyncio.wait_for(killed(), timeout=2)
    closing = asyncio.create_task(ws.close())
    await asyncio.sleep(0.05)
    store.gate.set()
    await asyncio.wait_for(closing, timeout=5)

    assert store.late == []
    assert store.closed


@pytest.mark.asyncio
async def test_close_is_idempotent_with_a_job_running():
    _RELEASE.clear()
    ws = _workspace()
    job = await _submit_deaf(ws)
    try:
        closing = asyncio.create_task(ws.close())
        await asyncio.wait_for(job.console.wait_finished(), timeout=2)
        for release in _RELEASE:
            release.set()
        await asyncio.wait_for(closing, timeout=5)
        await asyncio.wait_for(ws.close(), timeout=5)

        assert job.status == JobStatus.KILLED
    finally:
        for release in _RELEASE:
            release.set()
        await asyncio.sleep(0)


async def _leave_a_job_running() -> JobStatus:
    with Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE) as ws:
        await ws.shell("sleep 30 &")
        job = ws.job_table.all_running_jobs()[0]
    return job.status


def test_a_with_block_exits_inside_a_loop_with_a_job_running():
    # The job runs on the loop the block exits inside, which runs nothing
    # until the exit returns, so the close cannot wait for it.
    statuses: list[JobStatus] = []
    worker = threading.Thread(
        target=lambda: statuses.append(asyncio.run(_leave_a_job_running())),
        daemon=True,
    )
    worker.start()
    worker.join(timeout=10)
    assert statuses == [JobStatus.KILLED]


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_phase", ["runtime", "vfs"])
async def test_close_refuses_lifecycle_changes_but_allows_runtime_drain(
    monkeypatch, blocked_phase
):
    entered = asyncio.Event()
    release = asyncio.Event()
    vfs = RAMVFS()
    ws = Workspace({"/m": (vfs, MountMode.WRITE)})
    closes = []
    drained = []

    async def cli(_inv):
        return None, IOResult()

    spec = CLI(
        spec=CommandSpec(name="held"), handlers={"": CLIHandler(fn=cli)}
    )
    ws.register_cli("held", spec)

    class DrainingRuntime(Runtime):
        name = "draining"

        async def close(self):
            closes.append("runtime")
            if blocked_phase == "runtime":
                entered.set()
                await release.wait()
            await ws.vfs.write("/m/journal.txt", b"drained")

    close_vfs = vfs.close

    async def closing_vfs():
        closes.append("vfs")
        if blocked_phase == "vfs":
            entered.set()
            await release.wait()
        drained.append(await ws.vfs.read("/m/journal.txt"))
        await close_vfs()

    monkeypatch.setattr(vfs, "close", closing_vfs)
    runtime = DrainingRuntime()
    ws.add_runtime(runtime)
    closing = asyncio.create_task(ws.close())
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        for mutate in (
            lambda: ws.add_mount("/late", RAMVFS()),
            lambda: ws.set_mount_mode("/m", MountMode.READ),
            lambda: ws.add_runtime(runtime),
            lambda: ws.register_cli("late", spec),
            lambda: ws.unregister_cli("held"),
        ):
            with pytest.raises(RuntimeError, match="Workspace is closed"):
                mutate()
        with pytest.raises(RuntimeError, match="Workspace is closed"):
            await ws.unmount("/m")
        with pytest.raises(RuntimeError, match="Workspace is closed"):
            await ws.set_session_profile(ws.default_session_id, {})
    finally:
        release.set()
        await asyncio.wait_for(asyncio.gather(closing, ws.close()), timeout=5)

    assert closes == ["runtime", "vfs"]
    assert drained == [b"drained"]


@pytest.mark.asyncio
async def test_unmount_preserves_operations_of_each_surviving_vfs():
    class LabeledRAM(RAMVFS):
        def __init__(self, label):
            super().__init__()
            self.label = label
            self.closes = 0

        @vfs_call(effect=Effect.READ)
        async def identity(self, path):
            if self.closes:
                raise RuntimeError("VFS closed")
            return self.label.encode()

        async def close(self):
            self.closes += 1
            await super().close()

    class SpecializedRAM(LabeledRAM):
        @vfs_call(effect=Effect.READ)
        async def unique(self, path):
            return self.label.encode()

    first = LabeledRAM("first")
    second = SpecializedRAM("second")
    third = LabeledRAM("third")
    ws = Workspace({})

    async def identity(path, name="identity"):
        result, _ = await ws.dispatch(name, PathSpec.from_str_path(path))
        return result.decode()

    try:
        ws.add_mount("/first", first)
        ws.add_mount("/second", second)
        ws.add_mount("/third", third)
        assert await identity("/first/file") == "first"
        assert await identity("/second/file") == "second"
        assert await identity("/third/file") == "third"
        await ws.unmount("/second")
        assert second.closes == 1
        assert await identity("/first/file") == "first"
        assert await identity("/third/file") == "third"
        with pytest.raises(OSError) as missing:
            await identity("/first/file", "unique")
        assert missing.value.errno == errno.ENOTSUP
        await ws.unmount("/third")
        assert await identity("/first/file") == "first"
        assert await ws.vfs.readdir("/")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("secondary", [False, True])
@pytest.mark.parametrize("failure", [False, True])
async def test_close_settles_pending_profile_persistence(
    monkeypatch, secondary, failure
):
    ws = Workspace({})
    await ws.ensure_sessions_loaded()
    ws.create_session("peer")
    await ws.flush_sessions()
    session_id = "peer" if secondary else ws.default_session_id
    store = ws.state_store.sessions(ws.workspace_id)
    entered, release = asyncio.Event(), asyncio.Event()
    events = []
    cas_set = store.cas_set
    close_store = ws.state_store.close

    async def delayed_write(*args):
        entered.set()
        await release.wait()
        try:
            assert "store-closed" not in events
            if failure:
                raise RuntimeError("store unavailable")
            return await cas_set(*args)
        finally:
            events.append("write-finished")

    async def tracked_close():
        events.append("store-closed")
        await close_store()

    monkeypatch.setattr(store, "cas_set", delayed_write)
    monkeypatch.setattr(ws.state_store, "close", tracked_close)
    updating = asyncio.create_task(
        ws.set_session_profile(
            session_id, {"paths": {"hide": ["/data/secret"]}}
        )
    )
    closing = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        closing = asyncio.create_task(ws.close())
        await asyncio.sleep(0)
        assert not closing.done()
        assert events == []
        with pytest.raises(RuntimeError, match="Workspace is closed"):
            await ws.set_session_profile(session_id, {})
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(closing), timeout=0.03)
        release.set()
        if failure:
            with pytest.raises(RuntimeError, match="store unavailable"):
                await updating
        else:
            assert await updating is ws.get_session(session_id)
        await asyncio.wait_for(closing, 5)
        assert events == ["write-finished", "store-closed"]
    finally:
        release.set()
        await asyncio.gather(updating, return_exceptions=True)
        if closing is not None:
            await closing
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "surface,streaming",
    [
        ("op", False),
        ("op", True),
        ("command", False),
        ("command", True),
        ("df", False),
    ],
)
@pytest.mark.parametrize("alias", [None, "initial", "dynamic"])
@pytest.mark.parametrize("borrowed", [False, True])
async def test_unmount_waits_for_admitted_vfs_use(
    monkeypatch, surface, streaming, alias, borrowed
):
    vfs = RAMVFS()
    entered = asyncio.Event()
    release = asyncio.Event()
    closed = False
    index_closed = False

    async def chunks():
        entered.set()
        await release.wait()
        assert not closed
        assert not index_closed
        yield b"value"

    async def read_body():
        if streaming:
            return chunks()
        entered.set()
        await release.wait()
        assert not closed
        assert not index_closed
        return b"value"

    async def read(accessor, scope, **kwargs):
        return await read_body()

    async def command(accessor, paths, texts, opts):
        return await read_body(), IOResult()

    async def capacity():
        entered.set()
        await release.wait()
        assert not closed
        assert not index_closed
        return CapacityResult(state=CapacityState.UNKNOWN)

    monkeypatch.setattr(vfs, "capacity", capacity)
    mounts = {"/data": vfs}
    if alias == "initial":
        mounts["/alias"] = vfs
    owner = Workspace(mounts)
    ws = (
        await Workspace.from_state(await to_state_dict(owner), mounts=mounts)
        if borrowed
        else owner
    )
    if alias == "dynamic":
        ws.add_mount("/alias", vfs)
    override(vfs, "read", read)
    ws.mount("/data").register(
        Command(
            name="readvalue",
            spec=CommandSpec(
                arguments=(
                    Argument("paths", type="path", nargs="*", metavar=""),
                )
            ),
            vfs="ram",
            filetype=None,
            fn=command,
        )
    )
    close_vfs = vfs.close
    index = ws.mount("/data").index_store
    close_index = index.close

    async def close_index_store():
        nonlocal index_closed
        index_closed = True
        await close_index()

    monkeypatch.setattr(index, "close", close_index_store)

    async def close():
        nonlocal closed
        closed = True
        await close_vfs()

    monkeypatch.setattr(vfs, "close", close)

    async def consume():
        if surface == "df":
            result = await ws.shell("df /data")
            assert result.exit_code == 0
            return b"value"
        if surface == "command":
            return (await ws.shell("readvalue /data/file")).stdout
        value, _ = await ws.dispatch(
            "read", PathSpec.from_str_path("/data/file")
        )
        if isinstance(value, bytes):
            return value
        return b"".join([chunk async for chunk in value])

    running = asyncio.create_task(consume())
    removing = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        if alias:
            await ws.unmount("/data")
            assert not closed
        assert not index_closed
        removing = asyncio.create_task(
            ws.unmount("/alias" if alias else "/data")
        )
        async with asyncio.timeout(5):
            while (
                ws._registry.try_mount_for_prefix(
                    "/alias" if alias else "/data"
                )
                is not None
            ):
                await asyncio.sleep(0)
        assert not removing.done()
        assert not closed
        assert not index_closed
        release.set()
        assert await asyncio.wait_for(running, 5) == b"value"
        await asyncio.wait_for(removing, 5)
        assert closed == (not borrowed)
        assert index_closed
    finally:
        release.set()
        await asyncio.gather(
            running, *([removing] if removing else []), return_exceptions=True
        )
        await ws.close()
        await owner.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_unmount", [False, True])
async def test_workspace_close_waits_for_vfs_retirements(
    monkeypatch, cancel_unmount
):
    vfs = RAMVFS()
    ws = Workspace({"/data": vfs})
    entered = asyncio.Event()
    release = asyncio.Event()
    events = []
    close_vfs = vfs.close
    close_store = ws.state_store.close

    async def retiring_close():
        entered.set()
        await release.wait()
        await close_vfs()
        events.append("vfs")

    async def store_close():
        events.append("store")
        await close_store()

    monkeypatch.setattr(vfs, "close", retiring_close)
    monkeypatch.setattr(ws.state_store, "close", store_close)
    removing = asyncio.create_task(ws.unmount("/data"))
    closing = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        if cancel_unmount:
            removing.cancel()
            with pytest.raises(asyncio.CancelledError):
                await removing
        closing = asyncio.create_task(ws.close())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(closing), 0.03)
        assert events == []
        release.set()
        await asyncio.wait_for(closing, 5)
        assert events == ["vfs", "store"]
    finally:
        release.set()
        await asyncio.gather(
            removing, *([closing] if closing else []), return_exceptions=True
        )
        await ws.close()


@pytest.mark.asyncio
async def test_unmount_drains_metadata_glob_and_its_index_writes(monkeypatch):
    vfs = RAMVFS()
    ws = Workspace({"/data": vfs}, index=IndexConfig(ttl=600))
    entered, release = asyncio.Event(), asyncio.Event()
    closed = False
    raw = ws.mount("/data").index_store
    close_vfs = vfs.close

    async def close():
        nonlocal closed
        closed = True
        await close_vfs()

    async def glob(accessor, path, **kwargs):
        entered.set()
        await release.wait()
        assert not closed
        await raw.set_dir(
            "/data",
            [
                (
                    "late",
                    IndexEntry(id="late", name="late", resource_type="file"),
                )
            ],
        )
        return []

    override_glob(ws.mount("/data"), glob)
    monkeypatch.setattr(vfs, "close", close)
    expanding = asyncio.create_task(
        expand_operands(
            ws._namespace,
            [
                PathSpec(
                    virtual="/data/*",
                    directory="/data/",
                    vfs_path="*",
                    pattern="*",
                    resolved=False,
                )
            ],
        )
    )
    removing = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        removing = asyncio.create_task(ws.unmount("/data"))
        await asyncio.sleep(0.02)
        assert not removing.done()
        assert not closed
        release.set()
        await expanding
        await removing
        assert closed
        assert (await raw.list_dir("/data")).entries is None
    finally:
        release.set()
        await asyncio.gather(
            expanding,
            *([] if removing is None else [removing]),
            return_exceptions=True,
        )
        await ws.close()


@pytest.mark.asyncio
async def test_a_glob_writes_its_listing_through_a_lock_held_view(monkeypatch):
    vfs = RAMVFS()
    ws = Workspace({"/data": vfs}, index=IndexConfig(ttl=600))
    raw = ws.mount("/data").index_store
    handed = []

    async def glob(accessor, path, *, index=None, **kwargs):
        handed.append(index)
        await asyncio.wait_for(
            index.set_dir(
                "/data",
                [
                    (
                        "seen",
                        IndexEntry(
                            id="seen", name="seen", resource_type="file"
                        ),
                    )
                ],
            ),
            1,
        )
        return []

    override_glob(ws.mount("/data"), glob)
    try:
        result = await asyncio.wait_for(ws.shell("echo /data/*"), 5)
        assert (result.exit_code, result.stdout) == (0, b"/data/*\n")
        assert [type(index) for index in handed] == [IndexView]
        assert (await raw.list_dir("/data")).entries == ["/data/seen"]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["service", "clear"])
async def test_unmount_drains_service_index_invalidation(monkeypatch, kind):
    vfs = RAMVFS()
    ws = Workspace({"/data": vfs})
    entered, release = asyncio.Event(), asyncio.Event()
    index = ws.mount("/data").index_store
    method = "invalidate" if kind == "service" else "clear"
    invalidate = getattr(index, method)
    await index.put(
        "/outside-scope",
        IndexEntry(id="stale", name="stale", resource_type="ram"),
    )

    async def delayed_invalidate():
        entered.set()
        await release.wait()
        assert not vfs.is_closed
        await invalidate()

    monkeypatch.setattr(index, method, delayed_invalidate)
    manager = ws.mount("/data").cache_manager
    assert manager is not None
    updating = asyncio.create_task(
        drop_mount_caches(ws._registry)
        if kind == "service"
        else manager.clear_index(index)
    )
    removing = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        removing = asyncio.create_task(ws.unmount("/data"))
        await asyncio.sleep(0.02)
        assert not removing.done()
        assert not vfs.is_closed
        release.set()
        await updating
        await removing
        assert vfs.is_closed
        if kind == "clear":
            assert (await index.get("/outside-scope")).entry is None
    finally:
        release.set()
        await asyncio.gather(
            updating,
            *([] if removing is None else [removing]),
            return_exceptions=True,
        )
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("used", [False, True])
@pytest.mark.parametrize("wrapped", [False, True])
@pytest.mark.parametrize("unmount", [False, True])
async def test_restored_workspace_leaves_borrowed_mounts_open(
    used, wrapped, unmount
):
    vfs = RAMVFS()
    vfs.load_state({"files": {"/file": b"seed"}})
    ws = Workspace({"/data": vfs})
    state = await to_state_dict(ws)
    override = Mount(vfs, index=IndexConfig(ttl=37)) if wrapped else vfs
    replica = await Workspace.from_state(state, mounts={"/data": override})
    try:
        if used:
            assert (await replica.shell("cat /data/file")).stdout == b"seed"
        if unmount:
            await replica.unmount("/data")
            assert not vfs.is_closed
        await replica.close()
        assert not vfs.is_closed
        assert (await ws.shell("cat /data/file")).stdout == b"seed"
        await ws.close()
        assert vfs.is_closed
    finally:
        await replica.close()
        await ws.close()


def test_delete_clears_a_namespace_store_passed_in_directly():
    # A store handed in directly is where this workspace's links live,
    # so delete clears it too, not only the planes the state store owns.
    async def go():
        namespace = RAMNamespaceStore()
        ws = Workspace(
            {"/data/": RAMVFS()},
            mode=MountMode.WRITE,
            namespace_store=namespace,
        )
        await namespace.set("/data/l", {"mode": 0o600})
        await ws.delete()
        return await namespace.load()

    assert asyncio.run(go()) == {}


def test_delete_after_close_refuses_rather_than_keep_the_state_quietly():
    # close() closed the stores the state lives in, so a later delete
    # has nothing it can drop; it says so instead of answering success.
    async def go():
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        await ws.close()
        await ws.delete()

    with pytest.raises(RuntimeError, match="closed before delete"):
        asyncio.run(go())


@pytest.mark.asyncio
async def test_close_releases_later_resources_after_multiple_errors(
    monkeypatch,
):
    vfs = RAMVFS()
    ws = Workspace(mounts={"/data": vfs}, runtimes=[])
    closed = []

    async def runtime_close():
        closed.append("runtime")
        raise ValueError("runtime close failed")

    async def vfs_close():
        closed.append("vfs")
        raise RuntimeError("vfs close failed")

    async def store_close():
        closed.append("store")

    def processes_stop():
        closed.append("processes")
        raise OSError("process cancellation failed")

    monkeypatch.setattr(ws.processes, "stop", processes_stop)
    monkeypatch.setattr(ws._runtimes, "close", runtime_close)
    monkeypatch.setattr(vfs, "close", vfs_close)
    monkeypatch.setattr(ws._state_store, "close", store_close)
    with pytest.raises(BaseExceptionGroup) as error:
        await ws.close()
    assert closed == ["processes", "runtime", "vfs", "store"]
    assert len(error.value.exceptions) == 3
    with pytest.raises(BaseExceptionGroup) as repeated:
        await ws.close()
    assert repeated.value is error.value
    assert closed == ["processes", "runtime", "vfs", "store"]


async def _lines_running(ws: Workspace, count: int) -> None:
    for _ in range(500):
        if len(ws._lines) == count:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"expected {count} lines, saw {len(ws._lines)}")


@pytest.mark.asyncio
async def test_cancel_stops_only_the_named_sessions_lines():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    ws.create_session("a")
    ws.create_session("b")
    a = asyncio.create_task(ws.shell("sleep 30", session_id="a"))
    b = asyncio.create_task(ws.shell("sleep 30", session_id="b"))
    try:
        await _lines_running(ws, 2)
        assert await ws.cancel("a") == 1
        with pytest.raises(MirageAbortError):
            await a
        assert not b.done()
        assert await ws.cancel() == 1
        with pytest.raises(MirageAbortError):
            await b
        assert ws._lines == {}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cancel_reaches_a_line_queued_behind_another():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    running = asyncio.create_task(ws.shell("sleep 30"))
    queued = asyncio.create_task(ws.shell("echo late"))
    try:
        await _lines_running(ws, 2)
        assert await ws.cancel(ws.default_session_id) == 2
        for line in (running, queued):
            with pytest.raises(MirageAbortError):
                await line
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_kill_stops_background_jobs_and_keeps_the_session():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    ws.create_session("a")
    try:
        await ws.shell("sleep 30 &", session_id="a")
        assert await ws.kill("a") == 1
        assert ws.job_table.running_jobs("a") == []
        io = await ws.shell("echo alive", session_id="a")
        assert await io.stdout_str() == "alive\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_closing_a_session_cancels_its_running_line():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    ws.create_session("a")
    line = asyncio.create_task(ws.shell("sleep 30", session_id="a"))
    try:
        await _lines_running(ws, 1)
        await asyncio.wait_for(ws.close_session("a"), timeout=5)
        with pytest.raises(MirageAbortError):
            await line
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_capture_answers_ebusy_while_a_line_will_not_end():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    line = asyncio.create_task(ws.shell("sleep 30"))
    try:
        await _lines_running(ws, 1)
        with pytest.raises(OSError) as raised:
            async with ws._quiesced(0.1):
                pass
        assert raised.value.errno == errno.EBUSY
        assert await ws.cancel() == 1
        with pytest.raises(MirageAbortError):
            await line
        await ws.snapshot(io.BytesIO())
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_started_during_a_capture_runs_after_it():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    order: list[str] = []
    try:
        async with ws._quiesced():
            line = asyncio.create_task(ws.shell("echo after"))
            await asyncio.sleep(0.05)
            assert not line.done()
            order.append("captured")
        io_result = await line
        order.append(await io_result.stdout_str())
        assert order == ["captured", "after\n"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cancel_reaches_a_line_queued_behind_a_capture():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    try:
        async with ws._quiesced():
            line = asyncio.create_task(ws.shell("echo late > /f"))
            await asyncio.sleep(0.05)
            assert await ws.cancel() == 1
            with pytest.raises(MirageAbortError):
                await line
        result = await ws.shell("cat /f")
        assert result.exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_write_from_outside_a_line_waits_for_a_capture():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    try:
        async with ws._quiesced():
            write = asyncio.create_task(ws.vfs.write("/f", b"late"))
            await asyncio.sleep(0.05)
            assert not write.done()
        await write
        assert await ws.vfs.read("/f") == b"late"
    finally:
        await ws.close()
