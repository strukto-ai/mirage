import asyncio
import io
from pathlib import Path

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.observe.store import RAMObserverStore
from mirage.resource.ram import RAMResource
from mirage.resource.ram.store import RAMStore
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.mount.namespace.ram import RAMNamespaceStore
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.session.ram import RAMSessionStore
from mirage.workspace.session.store import SessionStore
from mirage.workspace.snapshot import to_state_dict
from mirage.workspace.store.ram import RAMWorkspaceStateStore


class ProbeNamespaceStore(RAMNamespaceStore):

    def __init__(self) -> None:
        super().__init__()
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


class ProbeObserverStore(RAMObserverStore):

    def __init__(self) -> None:
        super().__init__()
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


class ProbeSessionStore(RAMSessionStore):

    def __init__(self) -> None:
        super().__init__()
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


class ProbeWorkspaceStateStore(RAMWorkspaceStateStore):

    def __init__(self) -> None:
        super().__init__()
        self.namespace_probe = ProbeNamespaceStore()
        self.observer_probe = ProbeObserverStore()
        self.session_probe = ProbeSessionStore()
        self.close_calls = 0

    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        return self.namespace_probe

    def _make_observer(self, workspace_id: str) -> ProbeObserverStore:
        return self.observer_probe

    def _make_sessions(self, workspace_id: str) -> SessionStore:
        return self.session_probe

    async def _close(self) -> None:
        self.close_calls += 1
        await self.namespace_probe.close()
        await self.observer_probe.close()
        await self.session_probe.close()


class ProbeRAMResource(RAMResource):

    def __init__(self) -> None:
        super().__init__()
        self.close_calls = 0
        self.accessor = ProbeRAMAccessor(self._store)

    async def close(self) -> None:
        self.close_calls += 1
        await super().close()


class ProbeRAMAccessor(RAMAccessor):

    def __init__(self, store: RAMStore) -> None:
        super().__init__(store)
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


async def stdout(ws: Workspace, command: str) -> str:
    return await (await ws.execute(command)).stdout_str()


@pytest.mark.asyncio
async def test_mounted_mktemp_preserves_virtual_and_resource_paths():
    resource = RAMResource()
    ws = Workspace({"/scratch": resource}, mode=MountMode.WRITE)
    try:
        await ws.execute("mkdir -p /scratch/tmp")
        output = await stdout(ws, "mktemp -p /scratch/tmp agent.XXXX")
        virtual = output.strip()
        assert virtual.startswith("/scratch/tmp/agent.")
        assert await stdout(ws, f"cat {virtual}") == ""
        assert virtual.removeprefix(
            "/scratch") in resource.accessor.store.files

        directory = (await
                     stdout(ws, "mktemp -d -p /scratch/tmp run.XXXX")).strip()
        assert directory.startswith("/scratch/tmp/run.")
        assert directory.removeprefix("/scratch") \
            in resource.accessor.store.dirs
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_cache_tracks_overwrite_rename_and_unlink_commands():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    try:
        await ws.execute("echo old | tee /data/a.txt > /dev/null")
        assert await stdout(ws, "cat /data/a.txt") == "old\n"

        await ws.execute("echo new | tee /data/a.txt > /dev/null")
        assert await stdout(ws, "cat /data/a.txt") == "new\n"

        await ws.execute("mv /data/a.txt /data/b.txt")
        missing = await ws.execute("cat /data/a.txt")
        assert missing.exit_code == 1
        assert await stdout(ws, "cat /data/b.txt") == "new\n"

        await ws.execute("rm /data/b.txt")
        assert "b.txt" not in await stdout(ws, "ls /data")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_workspace_close_respects_store_ownership_end_to_end():
    shared = ProbeWorkspaceStateStore()
    first = Workspace({"/": RAMResource()},
                      mode=MountMode.WRITE,
                      store=shared,
                      workspace_id="shared")
    second = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       store=shared,
                       workspace_id="shared")

    await first.execute("echo first")
    await first.close()
    assert shared.close_calls == 0
    assert shared.namespace_probe.close_calls == 0
    assert shared.observer_probe.close_calls == 0
    assert shared.session_probe.close_calls == 0
    assert await stdout(second, "echo second") == "second\n"
    await second.close()

    owned = ProbeWorkspaceStateStore()
    owner = Workspace({"/": RAMResource()},
                      mode=MountMode.WRITE,
                      store=owned,
                      owns_store=True)
    await owner.execute("echo owner")
    await owner.close()
    await owner.close()
    assert owned.close_calls == 1
    assert owned.namespace_probe.close_calls == 1
    assert owned.observer_probe.close_calls == 1
    assert owned.session_probe.close_calls == 1


@pytest.mark.asyncio
async def test_close_leaves_resources_shared_with_other_workspaces_open():
    resource = ProbeRAMResource()
    ws = Workspace({"/data": resource}, mode=MountMode.WRITE)
    await ws.execute("echo seed | tee /data/a.txt > /dev/null")

    state = await to_state_dict(ws)
    replica = await Workspace.from_state(state, resources={"/data": resource})
    await replica.close()
    assert resource.close_calls == 0
    assert await stdout(ws, "cat /data/a.txt") == "seed\n"

    await ws.close()
    assert resource.close_calls == 1


def test_workspace_context_open_modes_and_cleanup():
    resource = ProbeRAMResource()
    store = ProbeWorkspaceStateStore()
    ws = Workspace({"/data": resource},
                   mode=MountMode.WRITE,
                   store=store,
                   owns_store=True)
    asyncio.run(ws.ops.write("/data/input.txt", b"original"))

    with ws:
        with open("/data/input.txt") as readable:
            assert readable.read() == "original"
            with pytest.raises(io.UnsupportedOperation, match="not writable"):
                readable.write("replacement")

        with open(Path("/data/input.txt"), "r", -1, "utf-8") as readable:
            assert readable.read() == "original"

        with open("/data/output.txt", "w") as writable:
            writable.write("created")
            with pytest.raises(io.UnsupportedOperation, match="not readable"):
                writable.read()

        with open("/data/input.txt", "r+") as update:
            update.write("changed")

        with open("/data/exclusive.txt", "x") as exclusive:
            exclusive.write("once")
        with pytest.raises(FileExistsError):
            open("/data/exclusive.txt", "x")

        closed = open("/data/closed.txt", "w")
        closed.close()
        with pytest.raises(ValueError, match="closed file"):
            closed.write("late")

    assert resource.accessor.store.files["/output.txt"] == b"created"
    assert resource.accessor.store.files["/input.txt"] == b"changedl"
    assert resource.accessor.store.files["/exclusive.txt"] == b"once"
    assert resource.close_calls == 1
    assert resource.accessor.close_calls == 1
    assert store.close_calls == 1
