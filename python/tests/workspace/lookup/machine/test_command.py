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
        "cd /data && ls",
        "cd /data && cat ../tmp/a.py",
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
async def test_absolute_paths_run_there_from_root_off_the_machine_s_folders():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    box = ScriptedMachine("box", files.answer)
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, machines={"box": box}
    )
    assert await out(ws, "cd /data && cat /tmp/a.py") == "ran\n"
    assert (files.ran, box.cwds) == (["cat /tmp/a.py"], ["/"])
    assert await out(ws, "cd /tmp && cat /tmp/a.py") == "ran\n"
    assert box.cwds[-1] == "/tmp"
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "tar -xf /tmp/a.tar",
        r"find /tmp -exec cat a.py \;",
        "wc -l /tmp/a.py",
        "grep -r -f /tmp/a.py",
    ],
)
async def test_a_command_that_may_use_its_folder_runs_only_from_the_machine_s(
    line,
):
    files = FakeFiles(
        {"/tmp/a.py": b"x", "/tmp/a.tar": b"x"},
        programs=(*TOOLS, "find", "tar"),
    )
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell(f"cd /data && {line}")
    name = line.split()[0]
    assert [r for r in files.ran if r.split()[0] == name] == []
    await ws.close()


@pytest.mark.asyncio
async def test_explain_names_the_machine_the_run_hands_a_command_to():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell("cd /data")

    async def placed(line: str) -> list[tuple[str, str]]:
        said = await ws.explain(line)
        return [(c.command, c.machine) for c in said.node.children]

    assert await placed("cat /tmp/a.py") == [("cat", "box")]
    assert await placed("ls") == [("ls", "")]
    assert await placed("cat /tmp/a.py /data/b") == [("cat", "")]
    assert await placed("wc -l /tmp/a.py") == [("wc", "")]
    assert await placed("grep -r -f /tmp/a.py") == [("grep", "")]
    await ws.shell("cd /tmp")
    assert await placed(r"find /tmp -exec cat /tmp/a.py \;") == [
        ("find", "box")
    ]
    assert await placed(r"find /tmp -exec cat /data/b \;") == [("find", "")]
    await ws.close()


@pytest.mark.asyncio
async def test_a_command_naming_no_path_runs_from_a_cwd_on_the_machine():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=TOOLS)
    ws = one(files)
    assert await out(ws, "cd /tmp && ls") == "ran\n"
    assert files.ran == ["ls"]
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
@pytest.mark.parametrize(
    "commands",
    [{"*": "deny", "ls": "allow"}, {"perl": "deny"}],
)
async def test_a_policy_refuses_a_program_the_machine_holds(commands):
    # The machine runs its own /tmp/ls or /tmp/perl, so a closed tree
    # refuses the path as it refuses one no machine holds, and a deny of
    # the program's name refuses it by that name.
    files = FakeFiles({"/tmp/ls": b"\x7fELF\x00", "/tmp/perl": b"\x7fELF\x00"})
    ws = one(files, profiles={"agent": {"commands": commands}})
    agent = await ws.session("agent", profile="agent")
    line = "/tmp/ls" if "ls" in commands else "/tmp/perl -e 1"
    assert (await agent.shell(line)).exit_code == 126
    assert files.ran == []
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
async def test_an_option_naming_another_mount_s_file_stays_with_mirage():
    files = FakeFiles({"/tmp/a.py": b"x\n"}, programs=TOOLS)
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell("echo x > /data/p")
    assert await out(ws, "grep -f /data/p /tmp/a.py") == "x\n"
    assert await out(ws, "grep --file=/data/p /tmp/a.py") == "x\n"
    assert files.ran == []
    await ws.close()


class NoCat(Policy):
    async def pre_command(self, ctx):
        return Deny(reason="no cat") if ctx.command == "cat" else None


@pytest.mark.asyncio
async def test_a_refused_command_never_reaches_a_machine():
    a = ScriptedMachine(
        "a", FakeFiles({"/tmp/x": b"x"}, programs=TOOLS).answer
    )
    b = ScriptedMachine("b", FakeFiles(programs=TOOLS).answer)
    ws = Workspace(
        {}, mode=MountMode.WRITE, machines={"a": a, "b": b}, policies=[NoCat()]
    )
    before = (len(a.lines), len(b.lines))
    done = await ws.shell("cat /tmp/x > /dev/null")
    assert done.exit_code == 126
    assert (len(a.lines), len(b.lines)) == before
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_link_to_a_hidden_name_reads_as_missing():
    files = FakeFiles({"/tmp/secret": b"s", "/tmp/a.py": b"x"}, programs=TOOLS)
    files.links["/tmp/public"] = "/tmp/secret"
    ws = one(files, profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}})
    agent = await ws.session("agent", profile="agent")
    done = await agent.shell("cat /tmp/public")
    assert (done.exit_code, await done.stdout_str()) == (1, "")
    assert await (await agent.shell("cat /tmp/a.py")).stdout_str() == "x"
    assert await out(ws, "cat /tmp/public") == "ran\n"
    await ws.close()


@pytest.mark.asyncio
async def test_find_exec_naming_another_mount_s_file_stays_with_mirage():
    files = FakeFiles({"/tmp/d/f": b"x"}, programs=(*TOOLS, "find"))
    ws = one(files, {"/data": RAMVFS()})
    await ws.shell("echo y > /data/x")
    line = r"find /tmp/d -maxdepth 0 -exec cat /data/x \;"
    assert await out(ws, line) == "y\n"
    assert files.ran == []
    await ws.close()
