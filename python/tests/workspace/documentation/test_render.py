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

from unittest.mock import AsyncMock

import pytest

from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import CommandSpec
from mirage.types import MountMode
from mirage.vfs.base import BaseVFS
from mirage.vfs.gdocs import GDocsConfig, GDocsVFS
from mirage.vfs.qdrant import QdrantConfig, QdrantVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.sharepoint import SharePointConfig, SharePointVFS
from mirage.vfs.slack import SlackConfig, SlackVFS
from mirage.workspace import Workspace
from mirage.workspace.documentation.constants import CHANGES


def row(markdown: str, section: str, path: str) -> str:
    """The text of one path's row in one of VFS.md's tables.

    Args:
        markdown (str): the document.
        section (str): the heading the table sits under; empty for the
            first table.
        path (str): the row's path.
    """
    body = markdown.split(section, 1)[1] if section else markdown
    return body.split(f"| `{path}` | ", 1)[1].split(" |\n", 1)[0]


@pytest.mark.asyncio
async def test_vfs_md_opens_with_its_frontmatter():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE)
    markdown = await ws.vfs_md()
    assert markdown.startswith(
        "---\nname: workspace-filesystem\ndescription: The virtual "
        "filesystem layout of this workspace.\n---\n\n# Virtual Filesystem\n"
    )


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
    assert (
        "| Path | Description |\n| --- | --- |\n"
        "| `/` | `ram`, exec |\n"
        "| `/data` | `ram`, read |\n"
        "| `/scratch` | `ram`, write |\n" in markdown
    )


@pytest.mark.asyncio
async def test_vfs_md_shows_a_layout_only_where_the_vfs_has_one():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE), "/slack": (slack, MountMode.READ)},
        mode=MountMode.WRITE,
    )
    markdown = await ws.vfs_md()
    assert "## `/slack` layout\n\n```text\n/slack\n  channels/" in markdown
    assert "## `/` layout" not in markdown


@pytest.mark.asyncio
async def test_vfs_md_shows_write_commands_for_writable_mounts():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    assert "slack send-message" in await ws.vfs_md()


@pytest.mark.asyncio
async def test_vfs_md_hides_write_commands_for_readonly():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.READ)},
        mode=MountMode.READ,
    )
    assert "slack send-message" not in await ws.vfs_md()


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
async def test_vfs_md_says_what_each_path_supports():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/data": (RAMVFS(), MountMode.READ),
            "/docs": (GDocsVFS(config=cfg), MountMode.WRITE),
            "/slack": (slack, MountMode.READ),
        },
        mode=MountMode.WRITE,
    )
    markdown = await ws.vfs_md()
    supported = "## Supported Unix Commands for VFS"
    limits = "## Limitations of Unix Commands for VFS"
    assert row(markdown, supported, "/") == "Almost all Unix commands."
    assert row(markdown, supported, "/docs") == (
        "Commands that read files (`ls`, `cat`, `grep`, `find`, `jq` and "
        "the rest), and `mv` and `rm`. `grep -r` and `rg` with `-w` use "
        "`gdocs` search."
    )
    assert row(markdown, limits, "/data").startswith(
        "Read only: no command changes files."
    )
    assert row(markdown, limits, "/docs").startswith(
        "Not supported: `>`, `>>`, `tee`, `touch` of a new file, `cp`, "
        "`cp -r`, `mkdir`, `rm -r`, `rmdir`, `truncate`, `sed -i`. Without "
        "`-w`, `grep -r` and `rg` read every file."
    )
    assert "`slack` search covers only `channels/*/*/chat.jsonl`" in row(
        markdown, limits, "/slack"
    )
    assert row(markdown, limits, "/").endswith(
        "`grep -r`, `find` and `du` stop after 10000 files; a glob matching "
        "more, `tar -c`, `cp -r` and `rm -r` are refused."
    )


@pytest.mark.asyncio
async def test_vfs_md_names_a_mounts_own_commands():
    qdrant = QdrantVFS(
        QdrantConfig(collection="c", group_by=["label"], id_field="id")
    )
    ws = Workspace({"/vectors": (qdrant, MountMode.READ)})
    markdown = await ws.vfs_md()
    assert row(
        markdown, "## Supported Unix Commands for VFS", "/vectors"
    ).endswith("Also `search`.")


@pytest.mark.asyncio
async def test_vfs_md_names_no_command_the_profile_denies():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"deny": ["rm", "grep", "tree"]}}},
    )
    markdown = await ws.vfs_md()
    assert "`rm" not in markdown
    assert "`grep" not in markdown
    assert "tree" not in markdown
    assert "`find` and `du` stop after" in markdown


@pytest.mark.asyncio
async def test_skill_md_lists_the_clis_the_profile_allows():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={"default": {"commands": {"deny": ["hidden"]}}},
    )
    for name in ("shown", "hidden"):
        ws.register_cli(
            name,
            CLI(
                CommandSpec(name=name),
                handlers={"": CLIHandler(AsyncMock())},
            ),
        )
    skill = await ws.skill_md()
    assert skill.startswith(
        "---\nname: workspace-commands\ndescription: The CLIs registered "
        "in this workspace and how to call them.\n---\n\n"
        "# Available commands\n"
    )
    assert "## `shown`" in skill
    assert "hidden" not in skill


@pytest.mark.asyncio
async def test_skill_md_says_when_no_cli_is_registered():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    assert (await ws.skill_md()).endswith("No CLIs are registered.\n")


SETUP = "echo hello > /m/f; mkdir /m/d0 /m/d1; echo x > /m/d1/a"
RUNS = {
    "`>`": "echo hi > /m/n",
    "`>>`": "echo hi >> /m/f",
    "`tee`": "echo hi | tee /m/t",
    "`touch` of a new file": "touch /m/new",
    "`cp`": "cp /m/f /m/c",
    "`cp -r`": "cp -r /m/d1 /m/d3",
    "`mkdir`": "mkdir /m/d",
    "`mv`": "mv /m/f /m/g",
    "`rm`": "rm /m/f",
    "`rm -r`": "rm -r /m/d1",
    "`rmdir`": "rmdir /m/d0",
    "`truncate`": "truncate -s 0 /m/f",
    "`sed -i`": "sed -i s/h/j/ /m/f",
}


async def seeded(ops: tuple[str, ...]) -> Workspace:
    filled = RAMVFS()
    seed = Workspace({"/m": (filled, MountMode.WRITE)})
    assert (await seed.shell(SETUP)).exit_code == 0
    partial = type(
        "Partial", (RAMVFS,), {op: getattr(BaseVFS, op) for op in ops}
    )()
    partial._store = filled._store
    partial.accessor = filled.accessor
    return Workspace({"/m": (partial, MountMode.WRITE)}, mode=MountMode.WRITE)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ops",
    [
        (),
        ("write",),
        ("write", "append", "pwrite", "truncate"),
        ("mkdir",),
        ("unlink",),
        ("rmdir",),
        ("rm_r",),
        ("rmdir", "rm_r"),
        ("rename",),
    ],
)
async def test_vfs_md_says_what_each_command_runs_on(ops):
    assert [c.label for c in CHANGES] == list(RUNS)
    markdown = await (await seeded(ops)).vfs_md()
    limits = row(markdown, "## Limitations of Unix Commands for VFS", "/m")
    missing = (
        limits.split("Not supported: ", 1)[1].split(".", 1)[0].split(", ")
        if "Not supported: " in limits
        else []
    )
    for label, line in RUNS.items():
        result = await (await seeded(ops)).shell(line)
        assert (result.exit_code == 0) == (label not in missing), (label, ops)
