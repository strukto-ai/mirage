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

import pytest

from mirage.policy import Action, Deny, Policy, PolicyDenied
from mirage.policy.types import SessionContext
from mirage.server.version.api import (branch, checkout, commit, commit_state,
                                       diff_live_vs_ref, read_version,
                                       resolve_ref, status_state, version_diff,
                                       version_log)
from mirage.server.version.backend import LocalBackend
from mirage.server.version.errors import NoSuchBranchError
from mirage.server.version.state_tree import META_PATH
from mirage.server.version.store import VersionStore
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.session.state import seed_var
from mirage.workspace.snapshot import to_state_dict
from mirage.workspace.snapshot.keys import CacheKey, StateKey


async def status(store, ws, branch="main"):
    return await status_state(store, await to_state_dict(ws), branch)


@pytest.mark.asyncio
async def test_checkout_restores_the_whole_world(tmp_path):
    """Rollback = the whole system state: files, sessions (cwd, env
    refs, mount grants), namespace symlinks, and the command history all
    return to what the commit captured."""
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.EXEC)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo original > /m/a.txt")
    await ws.shell("ln -s /m/a.txt /m/l.txt")
    narrow = ws.create_session("narrow", mounts={"/m": "read"})
    seed_var(narrow, "API_KEY", "@aws:prod-key")
    await ws.flush_sessions()
    await commit(store, ws, branch="main", message="v1")

    await ws.shell("echo mutated > /m/a.txt")
    await ws.shell("rm /m/l.txt")
    seed_var(narrow, "API_KEY", "@aws:other-key")
    narrow.mount_modes = {"/m": MountMode.WRITE}

    await checkout(store, ws, "main")

    result = await ws.shell("cat /m/a.txt")
    assert (await result.stdout_str()) == "original\n"
    result = await ws.shell("readlink /m/l.txt")
    assert (await result.stdout_str()).strip() == "/m/a.txt"
    restored = ws.get_session("narrow")
    assert restored.env["API_KEY"] == "@aws:prod-key"
    assert restored.mount_modes is not None
    assert restored.mount_modes["/m"] == MountMode.READ
    result = await ws.shell("history")
    history = (await result.stdout_str())
    assert "echo original > /m/a.txt" in history
    assert "echo mutated > /m/a.txt" not in history


def _cache_entry(data: bytes) -> dict:
    return {
        CacheKey.KEY: "k",
        CacheKey.DATA: data,
        CacheKey.FINGERPRINT: None,
        CacheKey.TTL: None,
        CacheKey.CACHED_AT: 0.0,
        CacheKey.SIZE: len(data),
    }


@pytest.mark.asyncio
async def test_commit_advances_branch_and_links_parent(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")

    await ws.shell("echo one > /m/a.txt")
    c1 = await commit(store, ws, branch="main", message="first")
    await ws.shell("echo two > /m/a.txt")
    c2 = await commit(store, ws, branch="main", message="second")

    assert await store.head("main") == c2
    assert (await store.read_commit(c2)).parents == [c1]
    assert await store.log("main") == [c2, c1]


@pytest.mark.asyncio
async def test_version_log_lists_messages_newest_first(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    await commit(store, ws, message="first")
    await ws.shell("echo two > /m/a.txt")
    await commit(store, ws, message="second")

    log = await version_log(store, "main")
    assert [entry["message"] for entry in log] == ["second", "first"]


@pytest.mark.asyncio
async def test_version_diff_reports_changed_files_only(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    c1 = await commit(store, ws, message="first")
    await ws.shell("echo two > /m/a.txt")
    await ws.shell("echo new > /m/b.txt")
    c2 = await commit(store, ws, message="second")

    diff = await version_diff(store, c1, c2)
    assert diff["modified"] == ["m/a.txt"]
    assert diff["added"] == ["m/b.txt"]
    assert META_PATH not in diff["modified"]


@pytest.mark.asyncio
async def test_diff_live_vs_ref_reports_changes_against_version(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    c1 = await commit(store, ws, branch="main", message="first")
    await ws.shell("echo two > /m/a.txt")
    await ws.shell("echo new > /m/b.txt")

    by_oid = await diff_live_vs_ref(store, await to_state_dict(ws), c1)
    assert by_oid["modified"] == ["m/a.txt"]
    assert by_oid["added"] == ["m/b.txt"]

    by_branch = await diff_live_vs_ref(store, await to_state_dict(ws), "main")
    assert by_branch == by_oid


@pytest.mark.asyncio
async def test_status_reports_uncommitted_changes(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    await commit(store, ws, message="first")
    await ws.shell("echo changed > /m/a.txt")

    st = await status(store, ws, "main")
    assert st["modified"] == ["m/a.txt"]


@pytest.mark.asyncio
async def test_diff_ignores_cache_churn(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")

    s1 = await to_state_dict(ws)
    s1[StateKey.CACHE][CacheKey.ENTRIES] = [_cache_entry(b"AAA")]
    c1 = await commit_state(store, s1, message="first")

    s2 = await to_state_dict(ws)
    s2[StateKey.CACHE][CacheKey.ENTRIES] = [_cache_entry(b"BBB")]
    c2 = await commit_state(store, s2, message="second")

    assert await version_diff(store, c1, c2) == {
        "added": [],
        "modified": [],
        "deleted": [],
    }


@pytest.mark.asyncio
async def test_status_state_reports_uncommitted_changes(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    await commit(store, ws, message="first")
    await ws.shell("echo changed > /m/a.txt")

    st = await status_state(store, await to_state_dict(ws), "main")
    assert st["modified"] == ["m/a.txt"]


@pytest.mark.asyncio
async def test_status_state_no_commit_yet_lists_all_as_added(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")

    st = await status_state(store, await to_state_dict(ws), "main")
    assert st == {"added": ["m/a.txt"], "modified": [], "deleted": []}


@pytest.mark.asyncio
async def test_status_ignores_cache_churn(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")

    s1 = await to_state_dict(ws)
    s1[StateKey.CACHE][CacheKey.ENTRIES] = [_cache_entry(b"AAA")]
    await commit_state(store, s1, message="first")

    live = await to_state_dict(ws)
    live[StateKey.CACHE][CacheKey.ENTRIES] = [_cache_entry(b"BBB")]
    st = await status_state(store, live, "main")

    assert st == {"added": [], "modified": [], "deleted": []}


@pytest.mark.asyncio
async def test_resolve_ref_branch_and_oid(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    c1 = await commit(store, ws, branch="main", message="first")

    assert await resolve_ref(store, "main") == c1
    assert await resolve_ref(store, c1) == c1
    assert await resolve_ref(store, c1.decode()) == c1


@pytest.mark.asyncio
async def test_commit_state_creates_version_from_state(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo hi > /m/a.txt")

    version = await commit_state(store,
                                 await to_state_dict(ws),
                                 branch="main",
                                 message="from state")

    entries, _ = await read_version(store, version)
    assert entries["m/a.txt"] == b"hi\n"


@pytest.mark.asyncio
async def test_commit_to_unknown_branch_errors(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    await commit(store, ws, branch="main", message="first")

    with pytest.raises(NoSuchBranchError):
        await commit(store, ws, branch="exp", message="oops")


@pytest.mark.asyncio
async def test_commit_diverges_after_branch_created(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    main_head = await commit(store, ws, branch="main", message="first")

    await branch(store, "exp", from_branch="main")
    await ws.shell("echo two > /m/a.txt")
    exp_head = await commit(store, ws, branch="exp", message="on exp")

    assert (await store.read_commit(exp_head)).parents == [main_head]
    assert await store.head("main") == main_head


@pytest.mark.asyncio
async def test_branch_creates_line_at_current(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo one > /m/a.txt")
    c1 = await commit(store, ws, branch="main", message="first")

    await branch(store, "exp", from_branch="main")

    assert await store.head("exp") == c1
    assert "exp" in await store.branches()


@pytest.mark.asyncio
async def test_read_version_reads_back_files_and_meta(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo hello > /m/a.txt")
    version = await commit(store, ws, message="first")

    entries, meta = await read_version(store, version)

    assert entries["m/a.txt"] == b"hello\n"
    assert META_PATH not in entries
    assert "/m/" in [m["prefix"] for m in meta["mounts"]]


@pytest.mark.asyncio
async def test_checkout_rebuilds_content_in_place(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    await ws.shell("echo original > /m/a.txt")
    await commit(store, ws, branch="main", message="first")

    await ws.shell("echo mutated > /m/a.txt")
    await ws.shell("echo extra > /m/b.txt")

    await checkout(store, ws, "main")

    result = await ws.shell("cat /m/a.txt")
    assert (await result.stdout_str()) == "original\n"
    assert await status(store, ws, "main") == {
        "added": [],
        "modified": [],
        "deleted": [],
    }


class DenyGate(Policy):
    """Refuse env writes to GATE_* names, the deployment's rule."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.plane == "env" and ctx.key.startswith("GATE_"):
            return Deny("GATE_* refused by policy\n")
        return None


# The live cache was cleared ahead of the restore's gate, so a refused
# checkout still sent every cached read back to its origin while the
# rest of the workspace stayed as it was; the clear now sits behind it.
@pytest.mark.asyncio
async def test_a_refused_checkout_leaves_the_live_cache_alone(tmp_path):
    ws = Workspace({"/m": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.EXEC)
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    try:
        seed_var(ws.create_session("s2"), "GATE_X", "1")
        await commit(store, ws, branch="main", message="v1")
        await ws.cache.set("k", b"cached")
        ws.policies.add(DenyGate())
        with pytest.raises(PolicyDenied):
            await checkout(store, ws, "main")
        assert await ws.cache.get("k") == b"cached"
    finally:
        await ws.close()
