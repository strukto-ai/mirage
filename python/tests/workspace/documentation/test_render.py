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

from collections.abc import Mapping
from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel

from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import command
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.io.types import IOResult
from mirage.types import JsonValue, MountMode, PathSpec
from mirage.utils.path import norm
from mirage.vfs.base import BaseVFS
from mirage.vfs.dify import DifyConfig, DifyVFS
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


@command("post", vfs="dify", spec=CommandSpec(), write=True)
async def post(accessor, paths, texts, opts):
    return None, IOResult()


NOTES = CLI(
    CommandSpec(
        name="notes",
        subcommands=(CommandSpec(name="show"), CommandSpec(name="add")),
    ),
    handlers={
        "show": CLIHandler(AsyncMock()),
        "add": CLIHandler(AsyncMock(), write=True),
    },
)


class TokenConfig(BaseModel):
    token: str


ACCOUNT = CLI(
    CommandSpec(name="acct", subcommands=(CommandSpec(name="list"),)),
    handlers={"list": CLIHandler(AsyncMock())},
    config_model=TokenConfig,
)

TOOL = CLI(
    CommandSpec(
        name="tool",
        arguments=(Argument("--token", required=True),),
        subcommands=(CommandSpec(name="run"),),
    ),
    handlers={"run": CLIHandler(AsyncMock())},
)


def dify() -> DifyVFS:
    return DifyVFS(
        DifyConfig(api_key="k", base_url="https://dify.test", dataset_id="d")
    )


class TreeCopyVFS(RAMVFS):
    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        store = self.accessor.store
        s, d = norm(src.mount_path), norm(dst.mount_path)
        for key in [k for k in store.dirs if k == s or k.startswith(s + "/")]:
            store.dirs.add(d + key[len(s) :])
        for key in [k for k in store.files if k.startswith(s + "/")]:
            store.files[d + key[len(s) :]] = store.files[key]


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
async def test_vfs_md_reads_read_where_no_command_changes_files():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    markdown = await ws.vfs_md()
    assert "| `/slack` | `slack`, read |" in markdown
    assert row(
        markdown, "## Limitations of Unix Commands for VFS", "/slack"
    ).startswith("Read only: no command changes files.")
    assert "slack send-message" not in markdown


@pytest.mark.asyncio
async def test_vfs_md_shows_the_users_own_text():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    slack.vfs_md = "{prefix}/channels holds our team's chat."
    ws = Workspace({"/slack": (slack, MountMode.READ)})
    markdown = await ws.vfs_md()
    assert "/slack/channels holds our team's chat." in markdown
    assert "<channel-name>__<channel-id>" not in markdown


@pytest.mark.asyncio
async def test_vfs_md_fences_a_layout_past_a_spaced_fence_inside_it():
    slack = SlackVFS(config=SlackConfig(token="xoxb-fake"))
    slack.vfs_md = "Run:\n  ```sh\n  ls {prefix}\n  ```  \nDone."
    ws = Workspace({"/slack": (slack, MountMode.READ)})
    markdown = await ws.vfs_md()
    assert "````text\nRun:\n  ```sh\n  ls /slack\n  ```  \nDone.\n````" in (
        markdown
    )


@pytest.mark.asyncio
async def test_vfs_md_substitutes_prefix():
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
        "the rest), and `mv`, `rm` and `unlink`. `grep -r` and `rg` with `-w` "
        "use `gdocs` search."
    )
    assert row(markdown, limits, "/data").startswith(
        "Read only: no command changes files."
    )
    assert row(markdown, limits, "/docs").startswith(
        "Not supported: `>`, `>>`, `tee`, `tee -a`, `touch` of a new file, "
        "`cp`, `cp -r`, `mkdir`, `rm -r`, `rmdir`, `truncate`, `sed -i`. "
        "Without `-w`, `grep -r` and `rg` read every file."
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
    assert "`rm`" not in markdown
    assert "`rm -r`" not in markdown
    assert "`rmdir`" in markdown
    assert "`grep" not in markdown
    assert "tree" not in markdown
    assert "`find` and `du` stop after" in markdown


@pytest.mark.asyncio
async def test_vfs_md_names_each_search_command_the_profile_allows():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    ws = Workspace(
        {"/docs": (GDocsVFS(config=cfg), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"deny": ["rg"]}}},
    )
    markdown = await ws.vfs_md()
    assert "`rg`" not in markdown
    assert "`grep -r` with `-w` uses `gdocs` search." in markdown
    assert "Without `-w`, `grep -r` reads every file." in markdown


@pytest.mark.asyncio
async def test_vfs_md_follows_a_rule_written_for_paths():
    ws = Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/data": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "commands": {"deny": [{"commands": {"rm": ["/data/*"]}}]}
            }
        },
    )
    markdown = await ws.vfs_md()
    supported = "## Supported Unix Commands for VFS"
    assert row(markdown, supported, "/") == "Almost all Unix commands."
    assert "`rm`" not in row(markdown, supported, "/data")
    assert "`mv`" in row(markdown, supported, "/data")


@pytest.mark.asyncio
async def test_vfs_md_summarizes_nothing_for_an_allow_list():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"allow": ["cat"]}}},
    )
    markdown = await ws.vfs_md()
    assert row(markdown, "## Supported Unix Commands for VFS", "/") == (
        "Commands that read files (`cat` and the rest), and `>` and `>>`."
    )


@pytest.mark.asyncio
async def test_vfs_md_counts_a_longer_form_the_allow_list_names():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    ws = Workspace(
        {"/docs": (GDocsVFS(config=cfg), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"allow": ["cat", "rm -f"]}}},
    )
    markdown = await ws.vfs_md()
    assert "| `/docs` | `gdocs`, write |" in markdown
    assert row(markdown, "## Supported Unix Commands for VFS", "/docs") == (
        "Commands that read files (`cat` and the rest), and `rm`."
    )


@pytest.mark.asyncio
async def test_vfs_md_keeps_the_denied_words_inside_a_longer_form():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    ws = Workspace(
        {"/docs": (GDocsVFS(config=cfg), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "commands": {
                    "allow": ["cat", "grep * needle"],
                    "deny": ["grep -r"],
                }
            }
        },
    )
    assert "`grep -r`" not in await ws.vfs_md()


@pytest.mark.asyncio
async def test_vfs_md_counts_no_help_request_as_a_write():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    ws = Workspace(
        {"/docs": (GDocsVFS(config=cfg), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"allow": ["cat", "rm --help"]}}},
    )
    markdown = await ws.vfs_md()
    assert "| `/docs` | `gdocs`, read |" in markdown
    assert "`rm`" not in row(
        markdown, "## Supported Unix Commands for VFS", "/docs"
    )


@pytest.mark.asyncio
async def test_vfs_md_names_no_search_whose_whole_word_form_is_denied():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    ws = Workspace(
        {"/docs": (GDocsVFS(config=cfg), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"deny": ["grep -r -w", "rg -w"]}}},
    )
    markdown = await ws.vfs_md()
    assert "`gdocs` search" not in markdown
    assert "Without `-w`" not in markdown


@pytest.mark.asyncio
async def test_vfs_md_counts_a_writer_of_the_mounts_own():
    ws = Workspace({"/kb": (dify(), MountMode.WRITE)}, mode=MountMode.WRITE)
    ws.mount("/kb").register_commands([post])
    markdown = await ws.vfs_md()
    assert "| `/kb` | `dify`, write |" in markdown
    assert "`post`" in row(
        markdown, "## Supported Unix Commands for VFS", "/kb"
    )
    assert row(
        markdown, "## Limitations of Unix Commands for VFS", "/kb"
    ).startswith("No Unix command changes files.")


@pytest.mark.asyncio
async def test_vfs_md_names_no_writer_of_a_read_only_mount():
    ws = Workspace({"/kb": (dify(), MountMode.READ)})
    ws.mount("/kb").register_commands([post])
    markdown = await ws.vfs_md()
    assert "`post`" not in row(
        markdown, "## Supported Unix Commands for VFS", "/kb"
    )


@pytest.mark.asyncio
async def test_vfs_md_reads_a_tree_leaf_by_leaf():
    ws = Workspace(
        {"/kb": (dify(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"allow": ["cat", "notes show"]}}},
    )
    ws.mount("/kb").register_commands([NOTES])
    markdown = await ws.vfs_md()
    assert "| `/kb` | `dify`, read |" in markdown
    assert "`notes`" in row(
        markdown, "## Supported Unix Commands for VFS", "/kb"
    )


@pytest.mark.asyncio
async def test_vfs_md_counts_unlink_as_a_change():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    ws = Workspace(
        {"/docs": (GDocsVFS(config=cfg), MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"allow": ["cat", "unlink"]}}},
    )
    markdown = await ws.vfs_md()
    assert "| `/docs` | `gdocs`, write |" in markdown
    assert row(markdown, "## Supported Unix Commands for VFS", "/docs") == (
        "Commands that read files (`cat` and the rest), and `unlink`."
    )


@pytest.mark.asyncio
async def test_vfs_md_describes_each_path_shown_with_its_own_mode():
    ws = Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/data": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    await ws.set_session_profile(
        ws.default_session_id, {"paths": {"show": {"/data/public": "r"}}}
    )
    markdown = await ws.vfs_md()
    assert row(
        markdown, "## Limitations of Unix Commands for VFS", "/data/public"
    ).startswith("Read only: no command changes files.")
    assert row(
        markdown, "## Supported Unix Commands for VFS", "/data/public"
    ).startswith("Commands that read files")
    await ws.close()


@pytest.mark.asyncio
async def test_vfs_md_names_no_search_a_mount_turned_off():
    cfg = GDocsConfig(
        client_id="x", client_secret="y", refresh_token="z", walk_limit=-1
    )
    ws = Workspace(
        {"/docs": (GDocsVFS(config=cfg), MountMode.READ)},
        mode=MountMode.READ,
    )
    assert "search" not in await ws.vfs_md()


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


def gws() -> CLI:
    leaf = {
        "drive list": CLIHandler(AsyncMock()),
        "drive delete": CLIHandler(AsyncMock()),
    }
    spec = CommandSpec(
        name="gws",
        subcommands=(
            CommandSpec(
                name="drive",
                subcommands=(
                    CommandSpec(name="list", description="List files."),
                    CommandSpec(name="delete", description="Delete one."),
                ),
            ),
        ),
    )
    return CLI(spec, handlers=leaf)


@pytest.mark.asyncio
async def test_skill_md_keeps_the_path_to_an_allowed_leaf():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={"default": {"commands": {"allow": ["gws drive list"]}}},
    )
    ws.register_cli("gws", gws())
    skill = await ws.skill_md()
    assert "## `gws`\n" in skill
    assert "## `gws drive`\n" in skill
    assert "## `gws drive list`" in skill
    assert "delete" not in skill


@pytest.mark.asyncio
async def test_skill_md_keeps_a_leaf_its_allow_list_names_with_arguments():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={"default": {"commands": {"allow": ["gws drive list --id"]}}},
    )
    ws.register_cli("gws", gws())
    skill = await ws.skill_md()
    assert "## `gws drive list`" in skill
    assert "delete" not in skill


@pytest.mark.asyncio
async def test_skill_md_keeps_the_options_of_a_group_above_an_allowed_leaf():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={"default": {"commands": {"allow": ["tool run"]}}},
    )
    ws.register_cli("tool", TOOL)
    skill = await ws.skill_md()
    assert "## `tool`\n" in skill
    assert "--token" in skill
    assert "## `tool run`" in skill


@pytest.mark.asyncio
async def test_skill_md_names_no_service_cli_a_path_hiding_profile_leaves_out():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={
            "default": {
                "paths": {"hide": ["/vault"]},
                "commands": {"allow": ["*"]},
            }
        },
    )
    ws.register_cli("acct", ACCOUNT, {"token": "t"})
    assert (await ws.skill_md()).endswith("No CLIs are registered.\n")


@pytest.mark.asyncio
async def test_skill_md_lists_no_denied_subcommand():
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={"default": {"commands": {"deny": ["gws drive delete"]}}},
    )
    ws.register_cli("gws", gws())
    skill = await ws.skill_md()
    assert "## `gws drive`" in skill
    assert "delete" not in skill.lower()


@pytest.mark.asyncio
async def test_skill_md_says_when_no_cli_is_registered():
    ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
    assert (await ws.skill_md()).endswith("No CLIs are registered.\n")


SETUP = "echo hello > /m/f; mkdir /m/d0 /m/d1; echo x > /m/d1/a"
RUNS = {
    "`>`": "echo hi > /m/n",
    "`>>`": "echo hi >> /m/f",
    "`tee`": "echo hi | tee /m/t",
    "`tee -a`": "echo hi | tee -a /m/f",
    "`touch` of a new file": "touch /m/new",
    "`cp`": "cp /m/f /m/c",
    "`cp -r`": "cp -r /m/d1 /m/d3",
    "`mkdir`": "mkdir /m/d",
    "`mv`": "mv /m/f /m/g",
    "`rm`": "rm /m/f",
    "`unlink`": "unlink /m/f",
    "`rm -r`": "rm -r /m/d1",
    "`rmdir`": "rmdir /m/d0",
    "`truncate`": "truncate -s 0 /m/f",
    "`sed -i`": "sed -i s/h/j/ /m/f",
}


async def seeded(
    ops: tuple[str, ...],
    kind: type[RAMVFS] = RAMVFS,
    profile: Mapping[str, JsonValue] | None = None,
) -> Workspace:
    filled = RAMVFS()
    seed = Workspace({"/m": (filled, MountMode.WRITE)})
    assert (await seed.shell(SETUP)).exit_code == 0
    partial = type(
        "Partial", (kind,), {op: getattr(BaseVFS, op) for op in ops}
    )()
    partial._store = filled._store
    partial.accessor = filled.accessor
    return Workspace(
        {"/m": (partial, MountMode.WRITE)},
        mode=MountMode.WRITE,
        profiles={} if profile is None else {"default": profile},
    )


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


@pytest.mark.asyncio
async def test_vfs_md_says_cp_r_copies_a_whole_tree_in_one_call():
    ws = await seeded(("mkdir",), TreeCopyVFS)
    limits = row(
        await ws.vfs_md(), "## Limitations of Unix Commands for VFS", "/m"
    )
    assert limits.startswith("Not supported: `mkdir`. ")
    assert (await ws.shell("cp -r /m/d1 /m/d3")).exit_code == 0
    assert (await ws.shell("cat /m/d3/a")).stdout == b"x\n"


@pytest.mark.asyncio
async def test_vfs_md_judges_tee_a_by_its_own_ops():
    ws = await seeded(
        ("write",), profile={"commands": {"allow": ["cat", "tee -a"]}}
    )
    markdown = await ws.vfs_md()
    assert "`tee -a`" in row(
        markdown, "## Supported Unix Commands for VFS", "/m"
    )
    assert row(
        markdown, "## Limitations of Unix Commands for VFS", "/m"
    ).startswith("Not supported: `>`. ")


@pytest.mark.asyncio
async def test_vfs_md_counts_rm_r_on_a_file_where_only_unlink_works():
    ws = await seeded(
        ("write", "append", "rmdir", "rm_r"),
        profile={"commands": {"allow": ["cat", "rm -r"]}},
    )
    assert row(await ws.vfs_md(), "", "/m").endswith(", write")
    assert (await ws.shell("rm -r /m/f")).exit_code == 0
