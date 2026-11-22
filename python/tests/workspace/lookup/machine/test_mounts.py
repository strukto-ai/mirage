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
from tests.fixtures.machine_files import TOOLS, FakeFiles, one, out


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
    assert await out(ws, "cat /tmp/both") == "1"
    assert (a.ran, b.ran) == (["cat /tmp/a.py"], [])
    await ws.close()


@pytest.mark.asyncio
async def test_from_a_shared_mount_s_root_the_machine_holding_the_path_runs():
    a = FakeFiles(programs=("cat",))
    b = FakeFiles({"/tmp/data/f": b"x"}, programs=("cat",))
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    assert await out(ws, "cd /tmp && cat data/f") == "ran\n"
    assert (a.ran, b.ran) == ([], ["cat data/f"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_name_on_two_machines_stays_with_mirage_from_any_folder():
    a = FakeFiles({"/srv/k": b"k", "/tmp/both": b"old"}, programs=TOOLS)
    b = FakeFiles({"/tmp/both": b"b"}, programs=TOOLS)
    ws = Workspace(
        {"/srv": "@a"},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    b.answer("cat > /tmp/both", b"new")
    assert await out(ws, "cd /srv && cat /tmp/both") == "new"
    assert await out(ws, "cd /srv && ls /tmp") == "both\n"
    assert (a.ran, b.ran) == ([], [])
    assert await out(ws, "cd /srv && cat k") == "ran\n"
    assert (a.ran, b.ran) == (["cat k"], [])
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
