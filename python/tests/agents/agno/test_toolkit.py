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

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.agno import MirageToolkit


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def toolkit(workspace):
    return MirageToolkit(workspace)


def test_registers_sync_and_async_tools(toolkit):
    expected = {"execute", "read", "write", "ls", "grep"}
    assert set(toolkit.functions) == expected
    assert set(toolkit.async_functions) == expected


def test_sync_tools(toolkit):
    toolkit.write("/notes/hello.txt", "hello world\n")
    assert "hello world" in toolkit.read("/notes/hello.txt")
    assert "hello.txt" in toolkit.ls("/notes")
    assert "hello world" in toolkit.grep("hello", "/notes")
    assert "1" in toolkit.execute("find /notes -type f | wc -l")


@pytest.mark.asyncio
async def test_async_tools(toolkit):
    await toolkit.awrite("/notes/hello.txt", "hello async\n")
    assert "hello async" in await toolkit.aread("/notes/hello.txt")
    assert "hello.txt" in await toolkit.als("/notes")
    assert "hello async" in await toolkit.agrep("hello", "/notes")
    assert "1" in await toolkit.aexecute("find /notes -type f | wc -l")
