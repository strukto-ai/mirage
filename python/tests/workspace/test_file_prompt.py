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
import re

import pytest

from mirage.commands.cli.builtin.ntn import NTN
from mirage.commands.cli.builtin.slack import SLACK
from mirage.commands.cli.skill import skill_for
from mirage.commands.cli.types import CLISpec
from mirage.io.types import IOResult
from mirage.resource.gdocs import GDocsConfig, GDocsResource
from mirage.resource.ram import RAMResource
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.store.ram import RAMWorkspaceStateStore


def test_file_prompt_includes_mounted_resources():
    ram = RAMResource()
    ws = Workspace(
        {"/": (ram, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    prompt = ws.file_prompt
    assert "/" in prompt
    assert "In-memory" in prompt


def test_file_prompt_shows_write_commands_for_writable_mounts():
    slack = SlackResource(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    prompt = ws.file_prompt
    assert "/slack" in prompt
    assert "Service writes require a CLI" in prompt


def test_file_prompt_hides_write_commands_for_readonly():
    slack = SlackResource(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.READ)},
        mode=MountMode.READ,
    )
    prompt = ws.file_prompt
    assert "/slack" in prompt
    assert "Service writes require a CLI" not in prompt


def test_file_prompt_substitutes_prefix_in_write_prompt():
    cfg = GDocsConfig(client_id="x", client_secret="y", refresh_token="z")
    gdocs = GDocsResource(config=cfg)
    ws = Workspace(
        {"/home/zecheng/gdocs": (gdocs, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    prompt = ws.file_prompt
    assert "/home/zecheng/gdocs/owned/<file>.gdoc.json" in prompt
    assert "{prefix}" not in prompt


def test_file_prompt_lists_installed_clis():
    ws = Workspace({}, mode=MountMode.WRITE)
    ws.register_cli("ntn", NTN, {"api_key": "secret_fake"})
    prompt = ws.file_prompt
    assert "Installed CLIs" in prompt
    assert "- ntn — " in prompt
    assert "Guide: man ntn" in prompt


def test_file_prompt_omits_cli_section_with_none_installed():
    ws = Workspace({}, mode=MountMode.WRITE)
    prompt = ws.file_prompt
    assert "Installed CLIs" not in prompt


def test_file_prompt_omits_clis_hidden_from_default_session():
    ws = Workspace({},
                   profiles={"reader": {
                       "commands": {
                           "allow": ["man"]
                       }
                   }},
                   profile="reader")
    ws.register_cli("ntn", NTN, {"api_key": "secret_fake"})
    assert "Installed CLIs" not in ws.file_prompt
    assert "Notion" not in ws.file_prompt


def test_file_prompt_omits_full_description_for_restricted_cli():
    ws = Workspace({},
                   profiles={
                       "reader": {
                           "commands": {
                               "allow": ["man", "ntn-prod pages get"]
                           }
                       }
                   },
                   profile="reader")
    ws.register_cli("ntn", NTN, {"api_key": "other"})
    ws.register_cli("ntn-prod", NTN, {"api_key": "secret_fake"})
    prompt = ws.file_prompt
    assert "- ntn —" not in prompt
    assert "Guide: man ntn-prod" in prompt
    skill = skill_for(NTN, "ntn-prod")
    assert skill is not None
    assert skill.description not in prompt


def test_file_prompt_does_not_recommend_hidden_man():
    ws = Workspace({},
                   profiles={"reader": {
                       "commands": {
                           "allow": ["ntn"]
                       }
                   }},
                   profile="reader")
    ws.register_cli("ntn", NTN, {"api_key": "secret_fake"})
    assert "Guide: man ntn" not in ws.file_prompt
    assert "run `man`" not in ws.file_prompt
    assert "Guide: ntn --help" in ws.file_prompt


def test_mount_prompt_uses_installed_alias_guide():
    resource = SlackResource(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace({"/customer-chat": (resource, MountMode.WRITE)})
    ws.register_cli("slack-customer", SLACK, {"token": "fake"})
    prompt = ws.file_prompt
    assert "Guide: man slack-customer" in prompt
    assert re.search(r"\bman slack(?=\s|$)", prompt) is None


def test_custom_cli_with_builtin_spec_name_keeps_its_own_guide():

    async def custom(inv):
        return None, IOResult()

    ws = Workspace({})
    ws.register_cli(
        "ntn-custom",
        CLISpec(name="ntn", description="Custom utility", fn=custom))
    assert "Custom utility" in ws.file_prompt
    assert "Notion" not in ws.file_prompt
    page = asyncio.run(ws.execute("man ntn-custom"))
    assert page.exit_code == 0
    assert b"Custom utility" in page.stdout
    assert b"Notion" not in page.stdout


def test_file_prompt_lists_each_install_of_a_shared_spec_separately():
    ws = Workspace({}, mode=MountMode.WRITE)
    ws.register_cli("ntn", NTN, {"api_key": "secret_fake"})
    ws.register_cli("ntn2", NTN, {"api_key": "secret_other"})
    prompt = ws.file_prompt
    assert "- ntn — " in prompt
    assert "Guide: man ntn" in prompt
    assert "- ntn2 — " in prompt
    assert "Guide: man ntn2" in prompt
    ntn_line = next(line for line in prompt.splitlines()
                    if line.startswith("- ntn — "))
    ntn2_line = next(line for line in prompt.splitlines()
                     if line.startswith("- ntn2 — "))
    ntn_desc = ntn_line.split("—", 1)[1].rsplit("Guide:", 1)[0]
    ntn2_desc = ntn2_line.split("—", 1)[1].rsplit("Guide:", 1)[0]
    # One skill, respelled for the head each install answers to.
    assert "`ntn` CLI" in ntn_desc
    assert "`ntn2` CLI" in ntn2_desc
    assert ntn_desc.replace("`ntn`", "`ntn2`") == ntn2_desc


@pytest.mark.asyncio
async def test_file_prompt_waits_for_persisted_default_session():
    store = RAMWorkspaceStateStore()
    owner = Workspace({},
                      store=store,
                      workspace_id="shared",
                      profiles={
                          "reader": {
                              "commands": {
                                  "allow": ["man", "ntn-prod pages get"]
                              }
                          }
                      },
                      profile="reader")
    await owner.ensure_sessions_loaded()
    await owner.flush_sessions()
    attached = Workspace({}, store=store, workspace_id="shared")
    attached.register_cli("ntn", NTN, {"api_key": "other"})
    attached.register_cli("ntn-prod", NTN, {"api_key": "fake"})
    assert "Installed CLIs" not in attached.file_prompt
    await attached.ensure_sessions_loaded()
    assert attached.default_session_id == owner.default_session_id
    assert "- ntn —" not in attached.file_prompt
    assert "Guide: man ntn-prod" in attached.file_prompt
    skill = skill_for(NTN, "ntn-prod")
    assert skill is not None
    assert skill.description not in attached.file_prompt
    await attached.close()
    await owner.close()


@pytest.mark.parametrize("manual,guide", [("man ls", "ntn --help"),
                                          ("man ntn", "man ntn")])
@pytest.mark.asyncio
async def test_file_prompt_checks_exact_manual_permission(manual, guide):
    ws = Workspace(
        {},
        profiles={"reader": {
            "commands": {
                "allow": [manual, "ntn"]
            }
        }},
        profile="reader")
    ws.register_cli("ntn", NTN, {"api_key": "fake"})
    assert "run `man`" not in ws.file_prompt
    assert f"Guide: {guide}" in ws.file_prompt
    result = await ws.execute(guide)
    assert result.exit_code == 0


@pytest.mark.parametrize(
    "shadow", ["ntn() { :; }", "shopt -s expand_aliases\nalias ntn=:"])
@pytest.mark.asyncio
async def test_file_prompt_omits_help_for_shadowed_cli(shadow):
    ws = Workspace({},
                   profiles={
                       "reader": {
                           "commands": {
                               "allow": ["ntn", "alias", "shopt"]
                           }
                       }
                   },
                   profile="reader")
    ws.register_cli("ntn", NTN, {"api_key": "fake"})
    assert (await ws.execute(shadow)).exit_code == 0
    assert "Guide: ntn --help" not in ws.file_prompt


@pytest.mark.asyncio
async def test_file_prompt_does_not_recommend_aliased_man():
    ws = Workspace({})
    ws.register_cli("ntn", NTN, {"api_key": "fake"})
    assert (await ws.execute("alias man=:")).exit_code == 0
    assert "Guide: man ntn" in ws.file_prompt
    assert (await ws.execute("man ntn")).exit_code == 0
    assert (await ws.execute("shopt -s expand_aliases")).exit_code == 0
    assert "run `man`" not in ws.file_prompt
    assert "Guide: man ntn" not in ws.file_prompt
    assert "Guide: ntn --help" in ws.file_prompt
    assert (await ws.execute("shopt -u expand_aliases")).exit_code == 0
    assert "Guide: man ntn" in ws.file_prompt
