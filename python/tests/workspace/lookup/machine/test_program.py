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

from tests.fixtures.machine_files import FakeFiles, one, out, two


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
async def test_a_program_file_two_machines_hold_runs_by_search_order():
    a = FakeFiles({"/tmp/tool": b"\x7fELF"})
    b = FakeFiles({"/tmp/tool": b"\x7fELF", "/srv/k": b"k", "/tmp/in": b"i"})
    ws = two(a, b, mounts={"/srv": "@b"})
    assert (await ws.shell("/tmp/tool first")).exit_code == 0
    await ws.shell("/tmp/tool named", machine="b")
    await ws.shell("cd /srv && /tmp/tool folder")
    await ws.shell("/tmp/tool /tmp/in")
    assert a.ran == ["/tmp/tool first"]
    assert b.ran == [
        "/tmp/tool named",
        "/tmp/tool folder",
        "/tmp/tool /tmp/in",
    ]
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_file_one_machine_holds_runs_there_whoever_is_named():
    a, b = FakeFiles(), FakeFiles({"/tmp/tool": b"\x7fELF"})
    ws = two(a, b)
    await ws.shell("/tmp/tool", machine="a")
    assert (a.ran, b.ran) == ([], ["/tmp/tool"])
    await ws.close()
