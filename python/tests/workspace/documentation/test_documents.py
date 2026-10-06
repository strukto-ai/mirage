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

from mirage import RAMVFS, MountMode, Workspace
from mirage.workspace.snapshot.keys import StateKey
from mirage.workspace.snapshot.state import apply_state_dict, to_state_dict


def workspace():
    return Workspace(
        {"/data": RAMVFS(), "/secret": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"reader": {"paths": {"hide": ["/secret"]}}},
    )


@pytest.mark.asyncio
async def test_a_preview_opens_no_session_and_each_reader_renders_its_own():
    ws = workspace()
    await ws.session("a", profile="reader")
    await ws.session("b")
    preview = await ws.vfs_md(profile="reader")
    assert "/secret" not in preview and len(ws.list_sessions()) == 3
    await ws.vfs_md("/VFS.md")
    restricted, full = await asyncio.gather(
        ws.vfs.read("/VFS.md", session_id="a"),
        ws.vfs.read("/VFS.md", session_id="b"),
    )
    assert restricted == preview.encode() and b"/secret" in full
    await ws.close()


@pytest.mark.asyncio
async def test_exact_paths_collisions_and_no_backend_writes():
    ws = workspace()
    await ws.vfs.mkdir("/data/guides")
    await ws.vfs.write("/data/exists", b"keep")
    with pytest.raises(FileExistsError):
        await ws.vfs_md("/data/exists")
    with pytest.raises(FileNotFoundError):
        await ws.skill_md("/skills/mirage/SKILL.md")
    for path in ("relative", "/", "/data/../VFS.md", "/data//VFS.md"):
        with pytest.raises(ValueError):
            await ws.vfs_md(path)
    with pytest.raises(ValueError):
        await ws.vfs_md("/VFS.md", profile="reader")
    with pytest.raises(ValueError):
        await ws.vfs_md(profile="reader", session_id="missing")
    await ws.vfs_md("/data/guides/VFS.md")
    await ws.vfs_md("/data/guides/VFS.md")
    with pytest.raises(FileExistsError):
        await ws.skill_md("/data/guides/VFS.md")
    assert await ws.vfs.read("/data/exists") == b"keep"
    data = ws._registry.try_mount_for_prefix("/data").vfs
    assert "/guides/VFS.md" not in data._store.files
    await ws.close()


@pytest.mark.asyncio
async def test_closed_session_does_not_leave_a_view_for_reused_id():
    ws = workspace()
    a = await ws.session("a")
    await a.vfs_md("/VFS.md")
    await ws.session("b")
    owner, other = [
        (await ws.shell("df", session_id=name)).stdout for name in ("a", "b")
    ]
    assert b" /VFS.md\n" in owner and b"/VFS.md" not in other
    await ws.close_session("a")
    await ws.session("a")
    with pytest.raises(FileNotFoundError):
        await ws.vfs.read("/VFS.md", session_id="a")
    await ws.close()


@pytest.mark.asyncio
async def test_unmount_and_closed_sessions_release_paths():
    ws = workspace()
    a = await ws.session("a")
    b = await ws.session("b")
    await a.vfs_md("/guide.md")
    await b.vfs_md("/guide.md")
    await ws.close_session("a")
    assert b"Virtual filesystem" in await ws.vfs.read(
        "/guide.md", session_id="b"
    )
    await ws.close_all_sessions()
    await ws.skill_md("/guide.md")
    await ws.unmount("/guide.md")
    await ws.vfs_md("/guide.md")
    assert b"Virtual filesystem" in await ws.vfs.read("/guide.md")
    await ws.close()


@pytest.mark.asyncio
async def test_subtree_modes_omit_unrestricted_backend_guidance():
    ws = workspace()
    await ws.set_session_profile(
        ws.default_session_id, {"paths": {"show": {"/data/public": "r"}}}
    )
    markdown = await ws.vfs_md()
    assert "In-memory" not in markdown
    assert "`/data/public`: read-only" in markdown
    await ws.close()


@pytest.mark.asyncio
async def test_copy_excludes_live_documents():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs_md("/VFS.md")
    await ws.skill_md("/SKILL.md")
    clone = await ws.copy()
    assert not await clone.vfs.exists("/VFS.md")
    assert not await clone.vfs.exists("/SKILL.md")
    await clone.vfs_md("/VFS.md")
    assert b"Virtual filesystem" in await clone.vfs.read("/VFS.md")
    await clone.close()
    await ws.close()


@pytest.mark.asyncio
async def test_a_link_above_the_name_binds_where_reads_land():
    ws = workspace()
    await ws.vfs.mkdir("/data/guides")
    linked = await ws.shell("ln -s /data/guides /guides")
    assert linked.exit_code == 0
    markdown = (await ws.vfs_md("/guides/VFS.md")).encode()
    assert await ws.vfs.read("/guides/VFS.md") == markdown
    assert await ws.vfs.read("/data/guides/VFS.md") == markdown
    await ws.close()


@pytest.mark.asyncio
async def test_an_in_place_load_drops_bindings_for_the_restored_file():
    source = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await source.vfs.write("/data/VFS.md", b"restored\n")
    state = await to_state_dict(source)
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs_md("/data/VFS.md")
    await apply_state_dict(ws, state)
    assert await ws.vfs.read("/data/VFS.md") == b"restored\n"
    await ws.vfs_md("/VFS.md")
    assert b"Virtual filesystem" in await ws.vfs.read("/VFS.md")
    await source.close()
    await ws.close()


@pytest.mark.asyncio
async def test_the_snapshot_audit_leaves_bindings_out():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    session = await ws.session("a")
    unbound = (await to_state_dict(ws))[StateKey.LIVE_ONLY_MOUNTS]
    await ws.vfs_md("/VFS.md")
    await session.skill_md("/SKILL.md")
    state = await to_state_dict(ws)
    assert state[StateKey.LIVE_ONLY_MOUNTS] == unbound
    await ws.close()
