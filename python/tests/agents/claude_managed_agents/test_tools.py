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
from anthropic import AsyncAnthropic
from anthropic.lib.tools import ToolError

from mirage import MountMode, Workspace
from mirage.agents.claude_managed_agents import mirage_tools
from mirage.vfs.ram import RAMVFS


@pytest.fixture
def tools():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    return {tool.name: tool for tool in mirage_tools(ws)}


def test_the_tools_carry_the_toolsets_names(tools):
    assert list(tools) == ["bash", "read", "write", "edit", "glob", "grep"]


def test_an_environment_worker_takes_the_tools():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    worker = AsyncAnthropic(api_key="test").beta.environments.work.worker(
        environment_id="env", environment_key="key", tools=mirage_tools(ws)
    )
    assert [tool.name for tool in worker._tools_for(None)] == [
        "bash",
        "read",
        "write",
        "edit",
        "glob",
        "grep",
    ]


def test_a_read_only_workspace_offers_no_write_or_edit():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.READ)
    names = [tool.name for tool in mirage_tools(ws)]
    assert "write" not in names and "edit" not in names
    assert "bash" in names and "read" in names


@pytest.mark.asyncio
async def test_bash_keeps_its_directory_and_files_follow_it(tools):
    await tools["bash"].call({"command": "mkdir -p /w && cd /w"})
    wrote = await tools["write"].call(
        {"file_path": "a.txt", "content": "hi\n"}
    )
    where = await tools["bash"].call({"command": "pwd; cat a.txt"})
    found = await tools["glob"].call({"pattern": "*.txt"})
    assert "a.txt" in wrote
    assert where == "/w\nhi\n"
    assert found == "/w/a.txt\n"


@pytest.mark.asyncio
async def test_a_failing_command_is_a_tool_error(tools):
    with pytest.raises(ToolError) as failed:
        await tools["bash"].call({"command": "echo nope >&2; exit 3"})
    assert "nope" in str(failed.value)


@pytest.mark.asyncio
async def test_a_command_past_its_timeout_is_a_tool_error(tools):
    with pytest.raises(ToolError) as failed:
        await tools["bash"].call({"command": "sleep 5", "timeout_ms": 50})
    assert "timed out" in str(failed.value)


@pytest.mark.asyncio
async def test_read_takes_a_line_range(tools):
    await tools["write"].call(
        {"file_path": "/n.txt", "content": "a\nb\nc\nd\n"}
    )
    text = await tools["read"].call(
        {"file_path": "/n.txt", "view_range": [2, 3]}
    )
    assert "b" in text and "c" in text
    assert "a" not in text and "d" not in text


@pytest.mark.asyncio
async def test_edit_replaces_text_after_a_read(tools):
    await tools["write"].call({"file_path": "/e.txt", "content": "hello\n"})
    await tools["read"].call({"file_path": "/e.txt"})
    await tools["edit"].call(
        {"file_path": "/e.txt", "old_string": "hello", "new_string": "hi"}
    )
    found = await tools["grep"].call({"pattern": "hi", "path": "/"})
    assert "/e.txt:1:hi" in found


@pytest.mark.asyncio
async def test_a_missing_file_is_a_tool_error(tools):
    with pytest.raises(ToolError) as failed:
        await tools["read"].call({"file_path": "/missing.txt"})
    assert "not found" in str(failed.value)
