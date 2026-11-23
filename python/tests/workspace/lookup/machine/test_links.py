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
from tests.fixtures.machine import ScriptedMachine
from tests.fixtures.machine_files import TOOLS, FakeFiles, one, out


@pytest.mark.asyncio
async def test_a_link_in_the_machine_s_folder_is_made_and_read_there():
    files = FakeFiles({"/tmp/a.py": b"x"}, programs=(*TOOLS, "ln", "readlink"))
    ws = one(files)
    await ws.shell("printf x | ln -s a.py /tmp/link")
    await ws.shell("readlink /tmp/link")
    assert files.ran == ["ln -s a.py /tmp/link", "readlink /tmp/link"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_link_in_a_folder_both_machines_hold_is_made_on_a_machine():
    a = FakeFiles({"/tmp/a.py": b"x"}, programs=("ln",))
    b = FakeFiles({"/tmp/d/t": b"t"}, programs=("ln",))
    first = ScriptedMachine("a", a.answer)
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        machines={"a": first, "b": ScriptedMachine("b", b.answer)},
    )
    await ws.shell("ln -s /tmp/a.py /tmp/link")
    await ws.shell("ln -s /tmp/d/t /tmp/d/link")
    await ws.shell("ln -s /tmp/a.py /tmp/named", machine="b")
    await ws.shell("ln -s /tmp/nowhere /tmp/dangling", machine="b")
    await ws.shell("cd /tmp && ln -s a.py beside")
    assert first.cwds[-1] == "/tmp"
    await ws.shell("cd /data && ln -s /tmp/a.py /tmp/from-store")
    assert first.cwds[-1] == "/"
    await ws.shell("cd /data && ln -s /tmp/a.py ../tmp/typed-relative")
    assert a.ran == [
        "ln -s /tmp/a.py /tmp/link",
        "ln -s /tmp/a.py /tmp/named",
        "ln -s a.py beside",
        "ln -s /tmp/a.py /tmp/from-store",
    ]
    assert b.ran == [
        "ln -s /tmp/d/t /tmp/d/link",
        "ln -s /tmp/nowhere /tmp/dangling",
    ]
    assert await out(ws, "readlink /tmp/typed-relative") == "/tmp/a.py\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_link_another_machine_would_break_stays_mirage_s():
    a = FakeFiles(
        {"/tmp/only/kept": b"k", "/tmp/existing": b"e"}, programs=("ln",)
    )
    b = FakeFiles({"/tmp/target": b"t"}, programs=("ln",))
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    await ws.shell("ln -s /tmp/target /tmp/only/link")
    assert await out(ws, "readlink /tmp/only/link") == "/tmp/target\n"
    taken = await ws.shell("ln -sT /tmp/target /tmp/existing")
    assert taken.exit_code == 1
    assert "File exists" in await taken.stderr_str()
    assert (a.ran, b.ran) == ([], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_hard_link_into_one_machine_s_folder_is_made_there():
    a = FakeFiles({"/tmp/t": b"old"}, programs=("ln",))
    b = FakeFiles({"/tmp/t": b"t", "/srv/kept": b"k"}, programs=("ln",))
    ws = Workspace(
        {"/srv": "@b"},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    b.answer("cat > /tmp/t", b"newer")
    assert (await ws.shell("ln /tmp/t /srv/link")).exit_code == 0
    assert (a.ran, b.ran) == ([], ["ln /tmp/t /srv/link"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_link_below_a_file_shown_over_a_folder_is_made_nowhere():
    a = FakeFiles({"/tmp/d/kept": b"k", "/tmp/t": b"t"}, programs=("ln",))
    b = FakeFiles({"/tmp/d": b"file"}, programs=("ln",))
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    b.answer("cat > /tmp/d", b"newer")
    made = await ws.shell("ln -s /tmp/t /tmp/d/link")
    assert made.exit_code == 1
    assert (a.ran, b.ran) == ([], [])
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
