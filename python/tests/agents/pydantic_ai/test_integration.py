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

from dataclasses import dataclass

import pytest
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel
from pydantic_ai_backends import create_console_toolset

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.pydantic_ai.backend import PydanticAIWorkspace


@dataclass
class Deps:
    backend: PydanticAIWorkspace


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def backend(workspace):
    return PydanticAIWorkspace(workspace)


def test_agent_write_and_read(backend):
    agent = Agent(
        TestModel(call_tools=["write_file", "read_file"]),
        deps_type=Deps,
        toolsets=[create_console_toolset()],
    )
    result = agent.run_sync("write a file", deps=Deps(backend=backend))
    assert result.output


def test_agent_ls(backend, workspace):
    import asyncio
    asyncio.run(backend.awrite("/data/file.txt", "hello"))

    agent = Agent(
        TestModel(call_tools=["ls"]),
        deps_type=Deps,
        toolsets=[create_console_toolset()],
    )
    result = agent.run_sync("list files in /data", deps=Deps(backend=backend))
    assert result.output


def test_agent_edit(backend):
    import asyncio
    asyncio.run(backend.awrite("/code.py", "x = 1\ny = 2\n"))

    agent = Agent(
        TestModel(call_tools=["edit_file"]),
        deps_type=Deps,
        toolsets=[create_console_toolset()],
    )
    result = agent.run_sync("change x to 42", deps=Deps(backend=backend))
    assert result.output


def test_agent_grep(backend):
    import asyncio
    asyncio.run(backend.awrite("/hello.txt", "hello world\ngoodbye world\n"))

    agent = Agent(
        TestModel(call_tools=["grep"]),
        deps_type=Deps,
        toolsets=[create_console_toolset()],
    )
    result = agent.run_sync("search for hello", deps=Deps(backend=backend))
    assert result.output


def test_no_real_filesystem(backend, workspace):
    import asyncio
    asyncio.run(backend.awrite("/test.txt", "in-memory content"))

    content = asyncio.run(workspace.fs.read("/test.txt"))
    assert content == b"in-memory content"

    import os
    assert not os.path.exists("/test.txt")
