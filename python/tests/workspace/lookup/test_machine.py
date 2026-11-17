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
from mirage.policy import Deny
from mirage.policy.base import Policy
from tests.fixtures.machine import ScriptedMachine
from tests.fixtures.machine_files import FakeFiles

TOOLS = ("ls", "cat", "grep", "wc")


def one(files: FakeFiles, mounts=None, **kwargs) -> Workspace:
    return Workspace(
        mounts or {},
        mode=kwargs.pop("mode", MountMode.WRITE),
        machines={"box": ScriptedMachine("box", files.answer)},
        **kwargs,
    )


async def out(ws: Workspace, line: str) -> str:
    return await (await ws.shell(line)).stdout_str()


@pytest.mark.asyncio
async def test_a_command_on_the_machine_s_paths_runs_there_whole():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files)
    assert await out(ws, "ls -la /tmp") == "ran\n"
    assert files.ran == ["ls -la /tmp"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_without_the_program_leaves_it_to_mirage():
    files = FakeFiles({"/tmp/a.py": b"x"})
    ws = one(files)
    assert await out(ws, "ls /tmp") == "a.py\n"
    assert files.ran == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_glob_hands_the_program_its_matches():
    files = FakeFiles(
        {"/tmp/a.py": b"x", "/tmp/b.py": b"y", "/tmp/c.txt": b"z"},
        programs=TOOLS,
    )
    ws = one(files)
    await out(ws, "grep -n x /tmp/*.py")
    assert files.ran == ["grep -n x /tmp/a.py /tmp/b.py"]
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /tmp/a.py /data/b",
        "cd /data && cat /tmp/a.py",
        "echo hi | wc -l",
        "echo hi | cat /tmp/a.py",
    ],
)
async def test_mirage_keeps_a_command_that_reaches_past_the_machine(line):
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell("echo b > /data/b")
    await ws.shell(line)
    assert files.ran == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_command_naming_no_path_runs_from_a_cwd_on_the_machine():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files)
    assert await out(ws, "cd /tmp && ls") == "ran\n"
    assert files.ran == ["ls"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_restricted_or_read_only_mount_stays_with_mirage():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files, profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}})
    agent = await ws.session("agent", profile="agent")
    assert await (await agent.shell("ls /tmp")).stdout_str() == "a.py\n"
    await ws.close()
    read_only = one(files, mode=MountMode.READ)
    assert await out(read_only, "ls /tmp") == "a.py\n"
    assert files.ran == []
    await read_only.close()


@pytest.mark.asyncio
async def test_on_two_machines_only_the_one_holding_every_path_runs_it():
    a = FakeFiles({"/tmp/a.py": b"x", "/tmp/both": b"1"}, programs=TOOLS)
    b = FakeFiles({"/tmp/both": b"2"}, programs=TOOLS)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    assert await out(ws, "cat /tmp/a.py") == "ran\n"
    assert (a.ran, b.ran) == (["cat /tmp/a.py"], [])
    both = await ws.shell("cat /tmp/both")
    assert both.exit_code == 1
    assert "on several machines: a, b" in await both.stderr_str()
    assert (a.ran, b.ran) == (["cat /tmp/a.py"], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_named_by_a_path_the_machine_holds_runs_there():
    files = FakeFiles({"/tmp/venv/bin/python": b"\x7fELF\x00"})
    ws = one(files)
    assert await out(ws, "cd /tmp && venv/bin/python -V") == "ran\n"
    assert await out(ws, "/tmp/venv/bin/python -V") == "ran\n"
    assert files.ran == ["venv/bin/python -V", "/tmp/venv/bin/python -V"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_hidden_program_path_stays_with_mirage():
    files = FakeFiles({"/tmp/secret/run": b"\x7fELF\x00"})
    ws = one(files, profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}})
    agent = await ws.session("agent", profile="agent")
    done = await agent.shell("/tmp/secret/run")
    assert done.exit_code != 0
    assert files.ran == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_command_in_a_read_loop_leaves_the_loop_its_input():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files)
    line = "printf 'a\\nb\\n' | while read l; do ls /tmp >/dev/null; echo $l; done"
    assert await out(ws, line) == "a\nb\n"
    assert files.ran == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_command_reading_dev_null_runs_there_whole():
    files = FakeFiles({"/tmp/a.py": b"x", "/tmp/b.py": b"y"}, programs=TOOLS)
    ws = one(files)
    assert await out(ws, "grep -l x /tmp/a.py < /dev/null") == "ran\n"
    assert await out(ws, "printf '/tmp/a.py /tmp/b.py' | xargs grep -l x") == (
        "ran\n"
    )
    assert files.ran == [
        "grep -l x /tmp/a.py",
        "grep -l x /tmp/a.py /tmp/b.py",
    ]
    await ws.close()


@pytest.mark.asyncio
async def test_a_link_in_the_machine_s_folder_is_made_and_read_there():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=(*TOOLS, "ln", "readlink"))
    ws = one(files)
    await ws.shell("printf x | ln -s a.py /tmp/link")
    await ws.shell("readlink /tmp/link")
    assert files.ran == ["ln -s a.py /tmp/link", "readlink /tmp/link"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_link_to_another_mount_stays_mirage_s_and_reads_through():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=(*TOOLS, "ln", "readlink"))
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell("echo b > /data/b && ln -s /data/b /tmp/l")
    assert await out(ws, "cat /tmp/l") == "b\n"
    assert await out(ws, "readlink /tmp/l") == "/data/b\n"
    assert await out(ws, "ls /tmp") == "a.py\nl\n"
    assert files.ran == []
    await ws.close()


class NoSecret(Policy):
    async def pre_vfs(self, ctx):
        if "secret" in ctx.path.virtual:
            return Deny(reason="secret")
        return None


@pytest.mark.asyncio
async def test_a_coded_file_policy_keeps_the_command_in_mirage():
    files = FakeFiles({"/tmp/secret": b"s", "/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files, policies=[NoSecret()])
    done = await ws.shell("cat /tmp/secret")
    assert done.exit_code != 0
    assert await out(ws, "cat /tmp/a.py") == "x"
    assert files.ran == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_glob_matching_a_mirage_link_stays_with_mirage():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=(*TOOLS, "ln"))
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell("echo y > /data/y && ln -s /data/y /tmp/l")
    assert await out(ws, "cat /tmp/*") == "xy\n"
    assert files.ran == []
    await ws.close()


@pytest.mark.asyncio
async def test_an_option_naming_another_mount_s_file_stays_with_mirage():
    files = FakeFiles({"/tmp/a.py": b"x\n"}, programs=TOOLS)
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell("echo x > /data/p")
    assert await out(ws, "grep -f /data/p /tmp/a.py") == "x\n"
    assert await out(ws, "grep --file=/data/p /tmp/a.py") == "x\n"
    assert files.ran == []
    await ws.close()
