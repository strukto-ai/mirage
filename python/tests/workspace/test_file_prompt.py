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

from mirage.commands.cli.builtin.ntn import NTN
from mirage.commands.cli.types import CLISpec
from mirage.io.types import IOResult
from mirage.resource.gdocs import GDocsConfig, GDocsResource
from mirage.resource.ram import RAMResource
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.types import MountMode
from mirage.workspace import Workspace


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
    assert "Writes go through the slack CLI" in prompt


def test_file_prompt_hides_write_commands_for_readonly():
    slack = SlackResource(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.READ)},
        mode=MountMode.READ,
    )
    prompt = ws.file_prompt
    assert "/slack" in prompt
    assert "Writes go through the slack CLI" not in prompt


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
