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
    assert "slack send-message" in prompt


def test_file_prompt_hides_write_commands_for_readonly():
    slack = SlackResource(config=SlackConfig(token="xoxb-fake"))
    ws = Workspace(
        {"/slack": (slack, MountMode.READ)},
        mode=MountMode.READ,
    )
    prompt = ws.file_prompt
    assert "/slack" in prompt
    assert "slack send-message" not in prompt


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
