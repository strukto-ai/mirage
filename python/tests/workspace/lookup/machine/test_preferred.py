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

from mirage import MountMode, Workspace
from mirage.policy import Deny
from mirage.policy.base import Policy
from mirage.vfs.machine.config import MachineVFSConfig
from mirage.vfs.machine.machine import MachineVFS
from tests.fixtures.machine import ScriptedMachine
from tests.fixtures.machine_files import FakeFiles, run, two


class Seen(Policy):
    async def pre_vfs(self, ctx):
        return None


@pytest.mark.asyncio
async def test_a_named_machine_takes_the_new_names_mirage_makes():
    a, b = FakeFiles(), FakeFiles()
    ws = two(a, b)
    assert (await ws.shell("touch /tmp/here")).exit_code == 0
    assert (await ws.shell("touch /tmp/there", machine="b")).exit_code == 0
    assert (await ws.shell("mkdir /tmp/d", machine="b")).exit_code == 0
    assert (a.files, b.files) == ({"/tmp/here": b""}, {"/tmp/there": b""})
    assert ("/tmp/d" in a.dirs, "/tmp/d" in b.dirs) == (False, True)
    await ws.close()


@pytest.mark.asyncio
async def test_a_folder_one_machine_shows_takes_the_new_names_made_from_it():
    a, b = FakeFiles(), FakeFiles({"/srv/kept": b"k"})
    ws = two(a, b, mounts={"/srv": "@b"})
    assert (await run(ws, "cd /srv && touch /tmp/from-b"))[0] == 0
    assert (await run(ws, "cd /tmp && touch /tmp/from-tmp"))[0] == 0
    assert (a.files, sorted(b.files)) == (
        {"/tmp/from-tmp": b""},
        ["/srv/kept", "/tmp/from-b"],
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_shared_folder_one_machine_holds_takes_the_new_names_from_it():
    a, b = FakeFiles(), FakeFiles({"/tmp/only/k": b"k"})
    ws = two(a, b)
    assert (await run(ws, "cd /tmp/only && touch /tmp/from-only"))[0] == 0
    assert (sorted(a.files), sorted(b.files)) == (
        [],
        ["/tmp/from-only", "/tmp/only/k"],
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_line_asks_who_holds_its_folder_once():
    a, b = FakeFiles(), FakeFiles({"/tmp/only/k": b"k"})
    first = ScriptedMachine("a", a.answer)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": first, "b": ScriptedMachine("b", b.answer)},
    )
    await ws.shell("cd /tmp/only")
    start = len(first.lines)
    await ws.shell("echo 1")
    one_echo = len(first.lines) - start
    start = len(first.lines)
    await ws.shell("echo 1; echo 2; echo 3; echo 4")
    assert one_echo > 0
    assert len(first.lines) - start == one_echo
    await ws.close()


class NoEcho(Policy):
    async def pre_command(self, ctx):
        return Deny(reason="no echo") if ctx.command == "echo" else None


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [NoEcho(), Seen()])
async def test_no_machine_is_asked_about_a_folder_for_a_refused_or_judged_line(
    policy,
):
    a, b = FakeFiles(), FakeFiles({"/tmp/only/k": b"k"})
    first = ScriptedMachine("a", a.answer)
    second = ScriptedMachine("b", b.answer)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": first, "b": second},
        policies=[policy],
    )
    await ws.shell("cd /tmp/only")
    before = (len(first.lines), len(second.lines))
    await ws.shell("echo 1")
    assert (len(first.lines), len(second.lines)) == before
    await ws.close()


@pytest.mark.asyncio
async def test_what_reads_a_program_s_pipe_writes_on_the_program_s_machine():
    a, b = FakeFiles(), FakeFiles({"/srv/k": b"k"})
    tmp = MachineVFS(MachineVFSConfig(root="/tmp", default_machine="b"))
    ws = two(a, b, mounts={"/tmp": tmp, "/srv": "@b"})
    assert (await run(ws, "echo x > /tmp/alone"))[0] == 0
    assert (await run(ws, "gen | tee /tmp/piped"))[0] == 0
    assert (await run(ws, "cd /srv && gen | tee /tmp/from-b"))[0] == 0
    assert sorted(a.files) == ["/tmp/piped"]
    assert sorted(b.files) == ["/srv/k", "/tmp/alone", "/tmp/from-b"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_child_shell_reading_the_pipe_keeps_its_writer_s_machine():
    a, b = FakeFiles(), FakeFiles()
    tmp = MachineVFS(MachineVFSConfig(root="/tmp", default_machine="b"))
    ws = two(a, b, mounts={"/tmp": tmp})
    assert (await run(ws, "gen | (tee /tmp/sub)"))[0] == 0
    assert (await run(ws, "gen | ( (tee /tmp/nested) )"))[0] == 0
    assert (await run(ws, "gen | { tee /tmp/group | cat; }"))[0] == 0
    assert (await run(ws, "nice gen | tee /tmp/wrapped"))[0] == 0
    assert (await run(ws, "gen | (tee /tmp/other) < /tmp/sub"))[0] == 0
    assert sorted(a.files) == [
        "/tmp/group",
        "/tmp/nested",
        "/tmp/sub",
        "/tmp/wrapped",
    ]
    assert sorted(b.files) == ["/tmp/other"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_reader_that_moves_keeps_the_machine_its_writer_started_on():
    a, b = FakeFiles({"/srv/k": b"k"}), FakeFiles({"/tmp/tool": b"\x7fELF"})
    ws = two(a, b, mounts={"/srv": "@a"})
    line = "/tmp/tool | (cd /srv && tee /tmp/moved)"
    assert (await run(ws, line))[0] == 0
    line = "/tmp/tool | while read l; do echo $l >> /tmp/looped; done"
    assert (await run(ws, line))[0] == 0
    assert sorted(a.files) == ["/srv/k"]
    assert sorted(b.files) == ["/tmp/looped", "/tmp/moved", "/tmp/tool"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_writer_named_from_its_folder_is_found_from_that_folder():
    a = FakeFiles({"/tmp/other/tool": b"\x7fELF"})
    b = FakeFiles({"/tmp/start/tool": b"\x7fELF"})
    ws = two(a, b)
    line = "cd /tmp/start && ./tool | (cd /tmp/other; tee /tmp/out)"
    assert (await run(ws, line))[0] == 0
    assert ("/tmp/out" in a.files, "/tmp/out" in b.files) == (False, True)
    await ws.close()


@pytest.mark.asyncio
async def test_under_a_file_policy_no_machine_runs_a_path_named_writer():
    a, b = FakeFiles(), FakeFiles({"/tmp/tool": b"\x7fELF"})
    ws = two(a, b, policies=[Seen()])
    await run(ws, "/tmp/tool | tee /tmp/out")
    await run(ws, "/tmp/tool > /tmp/direct")
    assert (a.ran, b.ran) == ([], [])
    assert sorted(a.files) == ["/tmp/direct", "/tmp/out"]
    assert sorted(b.files) == ["/tmp/tool"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_wrapped_writer_named_by_its_path_is_found_on_its_machine():
    a, b = FakeFiles(), FakeFiles({"/tmp/tool": b"\x7fELF"})
    ws = two(a, b)
    assert (await run(ws, "nice /tmp/tool | tee /tmp/out"))[0] == 0
    assert ("/tmp/out" in a.files, "/tmp/out" in b.files) == (False, True)
    await ws.close()


@pytest.mark.asyncio
async def test_what_reads_a_path_named_program_s_pipe_writes_on_its_machine():
    a, b = FakeFiles(), FakeFiles({"/tmp/tool": b"\x7fELF"})
    ws = two(a, b)
    assert (await run(ws, "/tmp/tool | tee /tmp/by-tool"))[0] == 0
    assert ("/tmp/by-tool" in a.files, "/tmp/by-tool" in b.files) == (
        False,
        True,
    )
    await ws.close()
