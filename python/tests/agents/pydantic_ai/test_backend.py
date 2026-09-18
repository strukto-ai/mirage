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

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.pydantic_ai.backend import PydanticAIWorkspace


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


@pytest.fixture
def backend(workspace):
    return PydanticAIWorkspace(workspace)


def test_id(backend):
    assert backend.id == "mirage"


def test_custom_id(workspace):
    b = PydanticAIWorkspace(workspace, sandbox_id="custom")
    assert b.id == "custom"


@pytest.mark.asyncio
async def test_aexecute_echo(backend):
    resp = await backend.aexecute("echo hello")
    assert resp.exit_code == 0
    assert "hello" in resp.output


@pytest.mark.asyncio
async def test_aexecute_failing_command(backend):
    resp = await backend.aexecute("cat /nonexistent")
    assert resp.exit_code != 0


@pytest.mark.asyncio
async def test_awrite_and_aread(backend):
    result = await backend.awrite("/test.txt", "hello world")
    assert result.error is None

    content = await backend.aread("/test.txt")
    assert "hello world" in content


@pytest.mark.asyncio
async def test_awrite_existing_file_errors(backend):
    await backend.awrite("/exists.txt", "first")
    result = await backend.awrite("/exists.txt", "second")
    assert result.error is not None


@pytest.mark.asyncio
async def test_aedit(backend):
    await backend.awrite("/edit.txt", "foo bar baz")
    result = await backend.aedit("/edit.txt", "bar", "qux")
    assert result.error is None
    content = await backend.aread("/edit.txt")
    assert "qux" in content
    assert "bar" not in content


@pytest.mark.asyncio
async def test_als_info(backend):
    await backend.awrite("/dir/a.txt", "a")
    await backend.awrite("/dir/b.txt", "b")
    entries = await backend.als_info("/dir")
    paths = [e["path"] for e in entries]
    assert len(paths) == 2


@pytest.mark.asyncio
async def test_agrep_raw(backend):
    await backend.awrite("/search.txt",
                         "hello world\ngoodbye world\nhello again")
    result = await backend.agrep_raw("hello", path="/")
    assert isinstance(result, list)
    assert len(result) >= 2


@pytest.mark.asyncio
async def test_aglob_info(backend):
    await backend.awrite("/data/a.txt", "a")
    await backend.awrite("/data/b.py", "b")
    entries = await backend.aglob_info("*.txt", path="/data")
    paths = [e["path"] for e in entries]
    assert any("a.txt" in p for p in paths)
    assert not any("b.py" in p for p in paths)


@pytest.mark.asyncio
async def test_execute_pipe(backend):
    await backend.awrite("/pipe.txt", "aaa\nbbb\nccc\naaa\n")
    resp = await backend.aexecute("cat /pipe.txt | sort | uniq | wc -l")
    assert resp.exit_code == 0
    assert "3" in resp.output


@pytest.mark.asyncio
async def test_read_bytes(backend):
    await backend.awrite("/bytes.txt", "binary content")
    data = await backend.aread_bytes("/bytes.txt")
    assert data == b"binary content"


@pytest.mark.asyncio
async def test_exists(backend):
    assert not await backend.aexists("/missing.txt")
    await backend.awrite("/exists.txt", "content")
    assert await backend.aexists("/exists.txt")


@pytest.mark.asyncio
async def test_a_hidden_path_is_hidden_on_the_op_door_too():
    """A confined backend answers the same on both of its doors.

    The shell door is handed the session on every line. The op door has
    to be handed it too, or a profile that hides a path hides it from
    `cat` and not from the read tool, which is the door an agent
    reaches for first.
    """
    ws = Workspace(
        {"/repo/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"reviewer": {
            "paths": {
                "hide": ["/repo/secrets"]
            }
        }})
    await ws.shell("mkdir -p /repo/secrets")
    await ws.shell("echo PRIVATE > /repo/secrets/key.pem")
    await ws.session("reviewer", profile="reviewer")

    backend = PydanticAIWorkspace(ws, session_id="reviewer")

    shell = await backend.aexecute("cat /repo/secrets/key.pem")
    assert shell.exit_code == 1
    assert "No such file" in shell.output

    assert "Error" in await backend.aread("/repo/secrets/key.pem")
    assert await backend.aexists("/repo/secrets/key.pem") is False


@pytest.mark.asyncio
async def test_the_host_door_still_sees_everything(workspace):
    """No session named means the host, which is not a confinement."""
    await workspace.shell("echo PRIVATE > /key.pem")
    backend = PydanticAIWorkspace(workspace)
    assert "PRIVATE" in await backend.aread("/key.pem")
