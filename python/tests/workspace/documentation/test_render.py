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

from mirage.types import MountMode
from mirage.vfs.gdocs import GDocsConfig, GDocsVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.sharepoint import SharePointConfig, SharePointVFS
from mirage.vfs.slack import SlackConfig, SlackVFS
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_vfs_md_includes_mounts():
    ram = RAMVFS()
    ws = Workspace(
        {"/": (ram, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    prompt = await ws.vfs_md()
    assert "/" in prompt
    assert "In-memory" in prompt


@pytest.mark.asyncio
async def test_vfs_md_shows_write_commands_for_writable_mounts():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    prompt = await ws.vfs_md()
    assert "/slack" in prompt
    assert "slack send-message" in prompt


@pytest.mark.asyncio
async def test_vfs_md_hides_write_commands_for_readonly():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.READ)},
        mode=MountMode.READ,
    )
    prompt = await ws.vfs_md()
    assert "/slack" in prompt
    assert "slack send-message" not in prompt


@pytest.mark.asyncio
async def test_vfs_md_substitutes_prefix_in_write_prompt():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    gdocs = GDocsVFS(config=cfg)
    ws = Workspace(
        {"/home/zecheng/gdocs": (gdocs, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    prompt = await ws.vfs_md()
    assert "/home/zecheng/gdocs/owned/<file>.gdoc.json" in prompt
    assert "{prefix}" not in prompt


@pytest.mark.asyncio
async def test_vfs_md_keeps_literal_braces():
    sharepoint = SharePointVFS(SharePointConfig(access_token="tok"))
    ws = Workspace(
        {"/sp": (sharepoint, MountMode.READ)},
        mode=MountMode.READ,
    )
    prompt = await ws.vfs_md()
    assert "/{site_name}/{library_name}/{path_to_file}" in prompt
    assert "{prefix}" not in prompt


@pytest.mark.asyncio
async def test_vfs_md_states_each_mount_mode():
    ws = Workspace(
        {
            "/": (RAMVFS(), MountMode.EXEC),
            "/data": (RAMVFS(), MountMode.READ),
            "/scratch": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    markdown = await ws.vfs_md()
    assert "## `/data`\n\nBackend: `ram`. Access: read-only." in markdown
    assert "## `/scratch`\n\nBackend: `ram`. Access: read-write." in markdown
    assert (
        "## `/`\n\nBackend: `ram`. Access: read-write; python3 and js can run"
        " code here." in markdown
    )
