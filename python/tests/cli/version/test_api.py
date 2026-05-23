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

from mirage.cli.version.api import (branch, checkout, commit, commit_state,
                                    read_version, snapshot_tree, status,
                                    version_diff, version_log)
from mirage.cli.version.mapping import META_PATH
from mirage.cli.version.store import VersionStore
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.snapshot import to_state_dict


@pytest.mark.asyncio
async def test_snapshot_tree_contains_files_and_meta(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.execute("echo hello > /m/a.txt")
    store = await VersionStore.open(tmp_path / ".mirage")

    tree = await snapshot_tree(store, ws)
    contents = await store.read_tree(tree)

    assert META_PATH in contents
    assert await store.read_blob(contents["m/a.txt"]) == b"hello\n"


@pytest.mark.asyncio
async def test_commit_advances_branch_and_links_parent(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")

    await ws.execute("echo one > /m/a.txt")
    c1 = await commit(store, ws, branch="main", message="first")
    await ws.execute("echo two > /m/a.txt")
    c2 = await commit(store, ws, branch="main", message="second")

    assert await store.head("main") == c2
    assert (await store.read_commit(c2)).parents == [c1]
    assert await store.log("main") == [c2, c1]


@pytest.mark.asyncio
async def test_version_log_lists_messages_newest_first(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")
    await ws.execute("echo one > /m/a.txt")
    await commit(store, ws, message="first")
    await ws.execute("echo two > /m/a.txt")
    await commit(store, ws, message="second")

    log = await version_log(store, "main")
    assert [entry["message"] for entry in log] == ["second", "first"]


@pytest.mark.asyncio
async def test_version_diff_reports_changed_files_only(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")
    await ws.execute("echo one > /m/a.txt")
    c1 = await commit(store, ws, message="first")
    await ws.execute("echo two > /m/a.txt")
    await ws.execute("echo new > /m/b.txt")
    c2 = await commit(store, ws, message="second")

    diff = await version_diff(store, c1, c2)
    assert diff["modified"] == ["m/a.txt"]
    assert diff["added"] == ["m/b.txt"]
    assert META_PATH not in diff["modified"]


@pytest.mark.asyncio
async def test_status_reports_uncommitted_changes(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")
    await ws.execute("echo one > /m/a.txt")
    await commit(store, ws, message="first")
    await ws.execute("echo changed > /m/a.txt")

    st = await status(store, ws, "main")
    assert st["modified"] == ["m/a.txt"]


@pytest.mark.asyncio
async def test_commit_state_creates_version_from_state(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")
    await ws.execute("echo hi > /m/a.txt")

    version = await commit_state(store,
                                 to_state_dict(ws),
                                 branch="main",
                                 message="from state")

    entries, _ = await read_version(store, version)
    assert entries["m/a.txt"] == b"hi\n"


@pytest.mark.asyncio
async def test_branch_creates_line_at_current(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")
    await ws.execute("echo one > /m/a.txt")
    c1 = await commit(store, ws, branch="main", message="first")

    await branch(store, "exp", from_branch="main")

    assert await store.head("exp") == c1
    assert "exp" in await store.branches()


@pytest.mark.asyncio
async def test_read_version_reads_back_files_and_meta(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")
    await ws.execute("echo hello > /m/a.txt")
    version = await commit(store, ws, message="first")

    entries, meta = await read_version(store, version)

    assert entries["m/a.txt"] == b"hello\n"
    assert META_PATH not in entries
    assert "/m/" in [m["prefix"] for m in meta["mounts"]]


@pytest.mark.asyncio
async def test_checkout_rebuilds_content_in_place(tmp_path):
    ws = Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    store = await VersionStore.open(tmp_path / ".mirage")
    await ws.execute("echo original > /m/a.txt")
    await commit(store, ws, branch="main", message="first")

    await ws.execute("echo mutated > /m/a.txt")
    await ws.execute("echo extra > /m/b.txt")

    await checkout(store, ws, "main")

    result = await ws.execute("cat /m/a.txt")
    assert (await result.stdout_str()) == "original\n"
    assert await status(store, ws, "main") == {
        "added": [],
        "modified": [],
        "deleted": [],
    }
