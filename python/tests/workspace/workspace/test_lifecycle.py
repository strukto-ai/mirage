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
import os
from fnmatch import fnmatchcase
from uuid import uuid4

import pytest

from mirage.cache.index.config import (IndexConfig, IndexEntry, LookupStatus,
                                       RedisIndexConfig)
from mirage.commands.cli.types import CLISpec
from mirage.commands.config import RegisteredCommand
from mirage.commands.spec import CommandSpec, Operand
from mirage.io import IOResult
from mirage.ops.registry import op
from mirage.resource.ram import RAMResource
from mirage.runtime.base import Runtime
from mirage.shell.console import Channel
from mirage.shell.job_table import JobStatus
from mirage.types import (CapacityResult, CapacityState, MountMode, PathSpec,
                          ResourceName)
from mirage.utils.key_prefix import mount_key
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.shared import expand_operands
from mirage.workspace.executor.command.run import drop_service_caches
from mirage.workspace.snapshot import to_state_dict
from mirage.workspace.types import ExecutionNode

_RELEASE: list[asyncio.Event] = []


@pytest.mark.asyncio
@pytest.mark.parametrize("action", [
    "glob", "midpath", "provision", "metadata", "touch", "chmod", "chown",
    "chgrp"
])
async def test_first_mount_access_prepares_expansion_and_provision(action):

    class IndexedRAM(RAMResource):

        def set_index(self, config=None):
            # Keep the backend's shared index across workspace configuration.
            if not hasattr(self, "_index"):
                super().set_index(config)

        async def resolve_glob(self, paths, prefix=""):
            listing = await self.index.list_dir(paths[0].directory.rstrip("/")
                                                or "/")
            if listing.entries is not None:
                return [
                    PathSpec.from_str_path(key, mount_key(key, prefix))
                    for key in listing.entries if fnmatchcase(
                        key.rsplit("/", 1)[-1], paths[0].pattern or "*")
                ]
            return await super().resolve_glob(paths, prefix)

    ancestor = RAMResource()
    ws = Workspace({"/": ancestor}, index=IndexConfig(ttl=600))
    replacement = IndexedRAM()
    replacement._index = ancestor.index
    replacement.load_state({
        "dirs": ["/", "/dir"],
        "files": {
            "/fresh.txt": b"new",
            "/dir/fresh.txt": b"new",
            "/file": b"new"
        }
    })
    directory = "/data/dir" if action == "midpath" else "/data"
    await ancestor.index.set_dir(
        directory,
        [("stale.txt",
          IndexEntry(id="old", name="stale.txt", resource_type="file"))])
    await ws.cache.set("/data/file", b"old")
    ws.add_mount("/data", replacement, MountMode.WRITE)
    try:
        if action == "provision":
            result = await ws.execute("cat /data/file", provision=True)
            assert result.cache_hits == 0
            assert (await ws.execute("cat /data/file")).stdout == b"new"
        elif action == "metadata":
            expanded = await expand_operands(ws._namespace, [
                PathSpec(virtual="/data/*.txt",
                         directory="/data/",
                         resource_path="*.txt",
                         pattern="*.txt",
                         resolved=False)
            ])
            assert [p.virtual for p in expanded] == ["/data/fresh.txt"]
        elif action in {"touch", "chmod", "chown", "chgrp"}:
            command = {
                "touch": "touch",
                "chmod": "chmod 600",
                "chown": "chown 123",
                "chgrp": "chgrp 456"
            }[action]
            result = await ws.execute(command + " /data/*.txt")
            assert result.exit_code == 0, result.stderr
            assert (
                await
                ws.execute("echo /data/*.txt")).stdout == b"/data/fresh.txt\n"
        else:
            pattern = "/data/*/*.txt" if action == "midpath" else "/data/*.txt"
            result = await ws.execute("echo " + pattern)
            assert result.stdout == f"{directory}/fresh.txt\n".encode()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_unmount_waits_for_an_inflight_cache_write(monkeypatch):

    class CachedRAM(RAMResource):
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
    reading = asyncio.create_task(ws.execute("cat /data/file"))
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
        assert (await ws.execute("cat /data/file")).stdout == b"new"
    finally:
        release.set()
        await asyncio.gather(reading,
                             *([removing] if removing else []),
                             return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_resource_cannot_be_remounted_while_close_is_pending(
        monkeypatch, cancel):
    resource = RAMResource()
    ws = Workspace({"/data": resource})
    entered = asyncio.Event()
    release = asyncio.Event()
    closed = asyncio.Event()
    close = resource.close

    async def blocked_close():
        entered.set()
        await release.wait()
        await close()
        closed.set()

    monkeypatch.setattr(resource, "close", blocked_close)
    removing = asyncio.create_task(ws.unmount("/data"))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        if cancel:
            removing.cancel()
            with pytest.raises(asyncio.CancelledError):
                await removing
        for prefix in ("/data", "/alias"):
            with pytest.raises(ValueError,
                               match="resource is being unmounted"):
                ws.add_mount(prefix, resource)
        release.set()
        await asyncio.wait_for(closed.wait(), timeout=5)
        await asyncio.sleep(0)
        if not cancel:
            await removing
        with pytest.raises(ValueError, match="resource is closed"):
            ws.add_mount("/data", resource)
        with pytest.raises(ValueError, match="resource is closed"):
            Workspace({"/data": resource})
        ws.add_mount("/data", RAMResource())
    finally:
        release.set()
        await asyncio.gather(removing, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["replace", "shadow", "reveal"])
async def test_retired_command_cannot_cache_bytes_for_replacement_mount(
        change):
    shadow = change == "shadow"

    class CachedRAM(RAMResource):
        caches_reads = True

    old = CachedRAM()
    old.load_state({"files": {"/data/file" if shadow else "/file": b"old"}})
    replacement = CachedRAM()
    replacement.load_state(
        {"files": {
            "/data/file" if change == "reveal" else "/file": b"new"
        }})
    entered = asyncio.Event()
    release = asyncio.Event()

    async def gate(_inv):
        entered.set()
        await release.wait()
        return None, IOResult()

    prefix = "/" if shadow else "/data"
    resources = {prefix: old}
    if change == "reveal":
        resources["/"] = replacement
    ws = Workspace(resources)
    ws.register_cli("gate", CLISpec(name="gate", fn=gate))
    retired = ws.mount(prefix).cache_manager
    running = asyncio.create_task(ws.execute("cat /data/file; gate"))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        if not shadow:
            await ws.unmount("/data")
        if change != "reveal":
            ws.add_mount("/data", replacement)
        release.set()
        result = await asyncio.wait_for(running, timeout=5)
        assert result.stdout == b"old"
        assert await ws.cache.get("/data/file") is None
        assert (await ws.execute("cat /data/file")).stdout == b"new"
        assert await ws.cache.get("/data/file") == b"new"
        assert retired is not None
        assert await retired.cached_bytes(
            PathSpec(virtual="/data/file",
                     directory="/data/",
                     resource_path="file")) is None
    finally:
        release.set()
        await asyncio.gather(running, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_eviction", [False, True])
@pytest.mark.parametrize("cache_kind", ["file", "index"])
async def test_unmount_keeps_prefix_reserved_until_cache_cleanup(
        monkeypatch, fail_eviction, cache_kind):
    resource = RAMResource()
    resource.load_state({"files": {"/file": b"old"}})
    ws = Workspace({"/data": resource}, mode=MountMode.WRITE)
    cache = ws.cache
    ws.add_mount("/alias", resource)
    alias_entries = await ws.fs.readdir("/alias")
    entered = asyncio.Event()
    release = asyncio.Event()
    store = cache if cache_kind == "file" else resource.index
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
            ws.add_mount("/data", RAMResource())
        with pytest.raises(OSError) as reading:
            await ws.fs.readdir("/data")
        assert reading.value.errno == errno.EBUSY
        with pytest.raises(OSError) as writing:
            await ws.fs.write("/data/file", b"changed")
        assert writing.value.errno == errno.EBUSY
        for line in ("cat /data/file", "echo changed > /data/file"):
            assert (await ws.execute(line)).exit_code != 0
        assert resource.get_state()["files"]["/file"] == b"old"
        release.set()
        if fail_eviction:
            with pytest.raises(RuntimeError, match="cache unavailable"):
                await removing
            assert ws.mount("/data").resource is resource
            monkeypatch.setattr(store, method, evict)
            await ws.unmount("/data")
        else:
            await removing
        assert await cache.get("/data") is None
        assert await cache.get("/data/file") is None
        assert await cache.get("/database/file") == b"peer"
        assert await ws.fs.readdir("/alias") == alias_entries
        ws.add_mount("/data", RAMResource())
    finally:
        release.set()
        await asyncio.gather(removing, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("store_kind", ["ram", "redis"])
@pytest.mark.parametrize("shadow", [False, True])
async def test_mount_change_invalidates_index_before_replacement(
        store_kind, shadow):
    config = IndexConfig()
    if store_kind == "redis":
        url = os.environ.get("REDIS_URL")
        if not url:
            pytest.skip("REDIS_URL not set")
        config = RedisIndexConfig(url=url, key_prefix=f"lifecycle:{uuid4()}:")
    resource = RAMResource()
    ws = Workspace({"/" if shadow else "/data": resource}, index=config)
    ws.add_mount("/alias", resource)
    index = resource.index
    entry = IndexEntry(id="old", name="private.txt", resource_type="file")
    try:
        await index.put("/data", entry)
        for path in ("/data", "/data/nested", "/database", "/alias"):
            await index.set_dir(path, [("private.txt", entry)])
        if not shadow:
            await ws.unmount("/data")
        replacement = RAMResource()
        ws.add_mount("/data", replacement)
        if shadow:
            assert await ws.fs.readdir("/data") == []
        for candidate in (index, replacement.index):
            for path in ("/data", "/data/private.txt",
                         "/data/nested/private.txt"):
                assert (await
                        candidate.get(path)).status == LookupStatus.NOT_FOUND
            for path in ("/data", "/data/nested"):
                assert (await candidate.list_dir(path)).entries in (None, [])
        for path in ("/database", "/alias"):
            assert (await
                    index.list_dir(path)).entries == [f"{path}/private.txt"]
    finally:
        await index.clear()
        await ws.close()


def _workspace() -> Workspace:
    return Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


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
    already gone. ``kill_all`` never joins the runner, so settling here
    cannot block shutdown on a job that is mid-write.
    """
    _RELEASE.clear()
    ws = _workspace()
    job = await _submit_deaf(ws)
    try:
        await asyncio.wait_for(ws.close(), timeout=5)

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


@pytest.mark.asyncio
async def test_close_is_idempotent_with_a_job_running():
    _RELEASE.clear()
    ws = _workspace()
    job = await _submit_deaf(ws)
    try:
        await asyncio.wait_for(ws.close(), timeout=5)
        await asyncio.wait_for(ws.close(), timeout=5)

        assert job.status == JobStatus.KILLED
    finally:
        for release in _RELEASE:
            release.set()
        await asyncio.sleep(0)


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_phase", ["runtime", "resource"])
async def test_close_refuses_lifecycle_changes_but_allows_runtime_drain(
        monkeypatch, blocked_phase):
    entered = asyncio.Event()
    release = asyncio.Event()
    resource = RAMResource()
    ws = Workspace({"/m": (resource, MountMode.WRITE)})
    closes = []
    drained = []

    async def cli(_inv):
        return None, IOResult()

    spec = CLISpec(name="held", fn=cli)
    ws.register_cli("held", spec)

    class DrainingRuntime(Runtime):
        name = "draining"

        async def close(self):
            closes.append("runtime")
            if blocked_phase == "runtime":
                entered.set()
                await release.wait()
            await ws.fs.write("/m/journal.txt", b"drained")

    close_resource = resource.close

    async def closing_resource():
        closes.append("resource")
        if blocked_phase == "resource":
            entered.set()
            await release.wait()
        drained.append(await ws.fs.read("/m/journal.txt"))
        await close_resource()

    monkeypatch.setattr(resource, "close", closing_resource)
    runtime = DrainingRuntime()
    ws.add_runtime(runtime)
    closing = asyncio.create_task(ws.close())
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        for mutate in (
                lambda: ws.add_mount("/late", RAMResource()),
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

    assert closes == ["runtime", "resource"]
    assert drained == [b"drained"]


@pytest.mark.asyncio
async def test_unmount_preserves_operations_of_each_surviving_resource():

    class LabeledRAM(RAMResource):

        def __init__(self, label, specialized=False):
            super().__init__()
            self.closes = 0

            @op("identity", resource="ram")
            async def identity(accessor, path, **kwargs):
                if self.closes:
                    raise RuntimeError("resource closed")
                return label.encode()

            self.register_op(identity)
            if specialized:

                @op("unique", resource="ram")
                async def unique(accessor, path, **kwargs):
                    return label.encode()

                self.register_op(unique)

        async def close(self):
            self.closes += 1
            await super().close()

    first = LabeledRAM("first")
    second = LabeledRAM("second", specialized=True)
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
        assert await ws.fs.readdir("/")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("secondary", [False, True])
@pytest.mark.parametrize("failure", [False, True])
async def test_close_settles_pending_profile_persistence(
        monkeypatch, secondary, failure):
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
        ws.set_session_profile(session_id,
                               {"paths": {
                                   "hide": ["/data/secret"]
                               }}))
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
@pytest.mark.parametrize("surface,streaming", [("op", False), ("op", True),
                                               ("command", False),
                                               ("command", True),
                                               ("df", False)])
@pytest.mark.parametrize("alias", [None, "initial", "dynamic"])
async def test_unmount_waits_for_admitted_resource_use(monkeypatch, surface,
                                                       streaming, alias):
    resource = RAMResource()
    entered = asyncio.Event()
    release = asyncio.Event()
    closed = False

    async def chunks():
        entered.set()
        await release.wait()
        assert not closed
        yield b"value"

    async def read_body():
        if streaming:
            return chunks()
        entered.set()
        await release.wait()
        assert not closed
        return b"value"

    @op("read", resource="ram")
    async def read(accessor, scope, **kwargs):
        return await read_body()

    async def command(accessor, paths, texts, opts):
        return await read_body(), IOResult()

    async def statfs():
        entered.set()
        await release.wait()
        assert not closed
        return CapacityResult(state=CapacityState.UNKNOWN)

    monkeypatch.setattr(resource, "statfs", statfs)
    resource.register_op(read)
    resources = {"/data": resource}
    if alias == "initial":
        resources["/alias"] = resource
    ws = Workspace(resources)
    if alias == "dynamic":
        ws.add_mount("/alias", resource)
    ws.mount("/data").register(
        RegisteredCommand(name="readvalue",
                          spec=CommandSpec(rest=Operand(type="path")),
                          resource="ram",
                          filetype=None,
                          fn=command))
    close_resource = resource.close

    async def close():
        nonlocal closed
        closed = True
        await close_resource()

    monkeypatch.setattr(resource, "close", close)

    async def consume():
        if surface == "df":
            result = await ws.execute("df /data")
            assert result.exit_code == 0
            return b"value"
        if surface == "command":
            return (await ws.execute("readvalue /data/file")).stdout
        value, _ = await ws.dispatch("read",
                                     PathSpec.from_str_path("/data/file"))
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
        removing = asyncio.create_task(
            ws.unmount("/alias" if alias else "/data"))
        async with asyncio.timeout(5):
            while ws._registry.try_mount_for_prefix(
                    "/alias" if alias else "/data") is not None:
                await asyncio.sleep(0)
        assert not removing.done()
        assert not closed
        release.set()
        assert await asyncio.wait_for(running, 5) == b"value"
        await asyncio.wait_for(removing, 5)
        assert closed
    finally:
        release.set()
        await asyncio.gather(running,
                             *([removing] if removing else []),
                             return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_unmount", [False, True])
async def test_workspace_close_waits_for_resource_retirements(
        monkeypatch, cancel_unmount):
    resource = RAMResource()
    ws = Workspace({"/data": resource})
    entered = asyncio.Event()
    release = asyncio.Event()
    events = []
    close_resource = resource.close
    close_store = ws.state_store.close

    async def retiring_close():
        entered.set()
        await release.wait()
        await close_resource()
        events.append("resource")

    async def store_close():
        events.append("store")
        await close_store()

    monkeypatch.setattr(resource, "close", retiring_close)
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
        assert events == ["resource", "store"]
    finally:
        release.set()
        await asyncio.gather(removing,
                             *([closing] if closing else []),
                             return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
async def test_unmount_drains_metadata_glob_and_its_index_writes(monkeypatch):
    resource = RAMResource()
    ws = Workspace({"/data": resource}, index=IndexConfig(ttl=600))
    entered, release = asyncio.Event(), asyncio.Event()
    closed = False
    index = resource.index
    close_resource = resource.close

    async def close():
        nonlocal closed
        closed = True
        await close_resource()

    async def glob(paths, prefix=""):
        entered.set()
        await release.wait()
        assert not closed
        await index.set_dir("/data", [
            ("late", IndexEntry(id="late", name="late", resource_type="file"))
        ])
        return []

    monkeypatch.setattr(resource, "resolve_glob", glob)
    monkeypatch.setattr(resource, "close", close)
    expanding = asyncio.create_task(
        expand_operands(ws._namespace, [
            PathSpec(virtual="/data/*",
                     directory="/data/",
                     resource_path="*",
                     pattern="*",
                     resolved=False)
        ]))
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
        assert (await index.list_dir("/data")).entries is None
    finally:
        release.set()
        await asyncio.gather(expanding,
                             *([] if removing is None else [removing]),
                             return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["service", "clear"])
async def test_unmount_drains_service_index_invalidation(monkeypatch, kind):
    resource = RAMResource()
    ws = Workspace({"/data": resource})
    entered, release = asyncio.Event(), asyncio.Event()
    index = resource.index
    method = "invalidate" if kind == "service" else "clear"
    invalidate = getattr(index, method)
    await index.put("/outside-scope",
                    IndexEntry(id="stale", name="stale", resource_type="ram"))

    async def delayed_invalidate():
        entered.set()
        await release.wait()
        assert not resource.is_closed
        await invalidate()

    monkeypatch.setattr(index, method, delayed_invalidate)
    manager = ws.mount("/data").cache_manager
    assert manager is not None
    updating = asyncio.create_task(
        drop_service_caches(ws._registry, (ResourceName.RAM, )) if kind ==
        "service" else manager.clear_index(index))
    removing = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        removing = asyncio.create_task(ws.unmount("/data"))
        await asyncio.sleep(0.02)
        assert not removing.done()
        assert not resource.is_closed
        release.set()
        await updating
        await removing
        assert resource.is_closed
        if kind == "clear":
            assert (await index.get("/outside-scope")).entry is None
    finally:
        release.set()
        await asyncio.gather(updating,
                             *([] if removing is None else [removing]),
                             return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("used", [False, True])
async def test_unmount_leaves_borrowed_resources_open(used):
    resource = RAMResource()
    resource.load_state({"files": {"/file": b"seed"}})
    ws = Workspace({"/data": resource})
    state = await to_state_dict(ws)
    replica = await Workspace.from_state(state, resources={"/data": resource})
    try:
        if used:
            assert (await replica.execute("cat /data/file")).stdout == b"seed"
        await replica.unmount("/data")
        assert not resource.is_closed
        await replica.close()
        assert not resource.is_closed
        await ws.close()
        assert resource.is_closed
    finally:
        await replica.close()
        await ws.close()
