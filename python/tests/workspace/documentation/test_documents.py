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
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Operand, Option


async def cli(inv):
    return None


def workspace():
    ws = Workspace(
        {"/data": RAMVFS(), "/secret": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"reader": {"paths": {"hide": ["/secret"]}}},
    )
    ws.register_cli(
        "tickets",
        CLISpec(
            name="tickets",
            description="Ticket operations",
            subcommands=(
                CLISpec(
                    name="list",
                    fn=cli,
                    options=(
                        Option(
                            long="--limit",
                            type="int",
                            metavar="N",
                            default="20",
                            description="Maximum rows",
                        ),
                    ),
                ),
                CLISpec(
                    name="delete",
                    fn=cli,
                    positional=(Operand(name="id", type="str"),),
                ),
            ),
        ),
    )
    return ws


@pytest.mark.asyncio
async def test_optional_independent_and_session_scoped():
    ws = workspace()
    a = await ws.session("a", profile="reader")
    b = await ws.session("b")
    before = await ws.vfs.readdir("/")
    assert "/VFS.md" not in before and "/SKILL.md" not in before
    preview = await ws.vfs_md(profile="reader")
    assert "/secret" not in preview
    assert len(ws.list_sessions()) == 3
    await a.vfs_md("/VFS.md")
    assert "/VFS.md" in await ws.vfs.readdir("/", session_id="a")
    assert "/VFS.md" not in await ws.vfs.readdir("/", session_id="b")
    with pytest.raises(FileNotFoundError):
        await ws.vfs.read("/VFS.md", session_id="b")
    assert await ws.vfs.read("/VFS.md", session_id="a") == preview.encode()
    await b.skill_md("/SKILL.md")
    assert "/SKILL.md" not in await ws.vfs.readdir("/", session_id="a")
    assert b"tickets list" in await ws.vfs.read("/SKILL.md", session_id="b")
    await ws.close()


@pytest.mark.asyncio
async def test_global_views_render_for_each_reader_and_refresh():
    ws = workspace()
    await ws.session("a", profile="reader")
    await ws.session("b")
    await ws.vfs_md("/VFS.md")
    await ws.skill_md("/SKILL.md")
    restricted, full = await asyncio.gather(
        ws.vfs.read("/VFS.md", session_id="a"),
        ws.vfs.read("/VFS.md", session_id="b"),
    )
    assert b"/secret" not in restricted and b"/secret" in full
    await ws.set_session_profile("b", "reader")
    assert await ws.vfs.read("/VFS.md", session_id="b") == restricted
    await ws.set_session_profile(
        "a", {"commands": {"allow": ["tickets list", "cat", "man"]}}
    )
    skill = await ws.vfs.read("/SKILL.md", session_id="a")
    assert b"tickets list" in skill and b"tickets delete" not in skill
    assert b"--limit" in skill and b"Maximum rows" in skill
    stat = await ws.vfs.stat("/SKILL.md", session_id="a")
    assert stat.size == len(skill)
    with pytest.raises(OSError):
        await ws.vfs.write("/SKILL.md", b"replacement", session_id="a")
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
