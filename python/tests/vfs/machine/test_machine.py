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
from mirage.policy.base import Policy
from mirage.runtime.types import RunAnswer
from mirage.vfs.machine.config import MachineVFSConfig
from mirage.vfs.machine.machine import MachineVFS
from mirage.vfs.ram import RAMVFS
from tests.fixtures.machine import ScriptedMachine, failed, table_of
from tests.fixtures.machine_files import FakeFiles, spec


def two(a: FakeFiles, b: FakeFiles, **kwargs) -> Workspace:
    return Workspace(
        kwargs.pop("mounts", {}),
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
        },
        **kwargs,
    )


async def run(ws: Workspace, line: str) -> tuple[int, str, str]:
    result = await ws.shell(line)
    return (
        result.exit_code,
        await result.stdout_str(),
        await result.stderr_str(),
    )


@pytest.mark.asyncio
async def test_a_heredoc_lands_in_the_machine_s_own_tmp():
    a = FakeFiles()
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": ScriptedMachine("a", a.answer)},
    )
    assert await run(ws, "cat > /tmp/fix.py << 'EOF'\nprint(1)\nEOF") == (
        0,
        "",
        "",
    )
    assert a.files["/tmp/fix.py"] == b"print(1)\n"
    assert await run(ws, "cat /tmp/fix.py") == (0, "print(1)\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_listing_merges_both_machines():
    a = FakeFiles({"/tmp/out.csv": b"1"})
    b = FakeFiles({"/tmp/model.bin": b"22", "/tmp/out.csv": b"1"})
    ws = two(a, b)
    assert await run(ws, "ls /tmp") == (0, "model.bin\nout.csv\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_name_on_both_machines_is_the_copy_written_last():
    a, b = FakeFiles({"/tmp/x": b"a"}), FakeFiles({"/tmp/x": b"b"})
    ws = two(a, b)
    assert await run(ws, "cat /tmp/x") == (0, "a", "")
    b.answer("cat > /tmp/x", b"later")
    assert await run(ws, "cat /tmp/x") == (0, "later", "")
    assert await run(ws, "wc -c < /tmp/x") == (0, "5\n", "")
    assert await run(ws, "stat -c %s /tmp/x") == (0, "5\n", "")
    assert await run(ws, "ls -l /tmp | grep -c ' 5 '") == (0, "1\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_write_goes_to_the_copy_written_last():
    a, b = FakeFiles({"/tmp/x": b"a"}), FakeFiles({"/tmp/x": b"b"})
    ws = two(a, b)
    b.answer("cat > /tmp/x", b"later")
    assert (await run(ws, "echo more >> /tmp/x"))[0] == 0
    assert (a.files["/tmp/x"], b.files["/tmp/x"]) == (b"a", b"latermore\n")
    assert (await run(ws, "echo new > /tmp/x"))[0] == 0
    assert (a.files["/tmp/x"], b.files["/tmp/x"]) == (b"a", b"new\n")
    await ws.close()


@pytest.mark.asyncio
async def test_rm_takes_the_name_off_every_machine():
    a, b = FakeFiles({"/tmp/x": b"a"}), FakeFiles({"/tmp/x": b"b"})
    ws = two(a, b)
    assert await run(ws, "rm /tmp/x") == (0, "", "")
    assert (a.files, b.files) == ({}, {})
    code, _, err = await run(ws, "cat /tmp/x")
    assert (code, "No such file or directory" in err) == (1, True)
    await ws.close()


@pytest.mark.asyncio
async def test_mv_takes_the_old_name_off_every_machine():
    a, b = FakeFiles({"/tmp/x": b"a"}), FakeFiles({"/tmp/x": b"b"})
    ws = two(a, b)
    b.answer("cat > /tmp/x", b"later")
    assert (await run(ws, "mv /tmp/x /tmp/y"))[0] == 0
    assert (a.files, b.files) == ({}, {"/tmp/y": b"later"})
    assert await run(ws, "ls /tmp") == (0, "y\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_new_name_lands_where_its_folder_is():
    a, b = FakeFiles(), FakeFiles({"/tmp/d/kept": b"k"})
    ws = two(a, b)
    assert (await run(ws, "echo hi > /tmp/d/new"))[0] == 0
    assert (await run(ws, "mkdir -p /tmp/d/sub/deep"))[0] == 0
    assert (await run(ws, "touch /tmp/top"))[0] == 0
    assert (a.files, b.files) == (
        {"/tmp/top": b""},
        {"/tmp/d/kept": b"k", "/tmp/d/new": b"hi\n"},
    )
    assert ("/tmp/d" in a.dirs, "/tmp/d/sub/deep" in b.dirs) == (False, True)
    await ws.close()


@pytest.mark.asyncio
async def test_mv_stays_on_the_source_s_machine():
    a, b = FakeFiles(), FakeFiles({"/tmp/m": b"m"})
    ws = two(a, b)
    assert (await run(ws, "mv /tmp/m /tmp/n"))[0] == 0
    assert (b.files, a.files) == ({"/tmp/n": b"m"}, {})
    await ws.close()


@pytest.mark.asyncio
async def test_mv_onto_another_machine_s_name_replaces_it():
    a, b = FakeFiles({"/tmp/src": b"new"}), FakeFiles({"/tmp/dst": b"old"})
    ws = two(a, b)
    assert (await run(ws, "mv /tmp/src /tmp/dst"))[0] == 0
    assert (a.files, b.files) == ({"/tmp/dst": b"new"}, {})
    assert await run(ws, "cat /tmp/dst") == (0, "new", "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_failed_mv_keeps_another_machine_s_folder():
    a, b = FakeFiles({"/tmp/src/f": b"x"}), FakeFiles()
    b.dirs.add("/tmp/dst")

    def refusing(line, data):
        if line.startswith("mv "):
            return failed(b"mv: cannot move '/tmp/src': Permission denied\n")
        return a.answer(line, data)

    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", refusing),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    assert (await run(ws, "mv -T /tmp/src /tmp/dst"))[0] == 1
    assert "/tmp/dst" in b.dirs
    await ws.close()


@pytest.mark.asyncio
async def test_lists_a_folder_under_another_machine_s_file():
    a, b = FakeFiles({"/tmp/d/sub/g": b"y"}), FakeFiles({"/tmp/d": b"f"})
    ws = two(a, b)
    assert await run(ws, "ls /tmp/d/sub") == (0, "g\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_mv_into_a_folder_no_machine_holds_fails():
    a, b = FakeFiles({"/tmp/src": b"x"}), FakeFiles()
    ws = two(a, b)
    code, _, err = await run(ws, "mv /tmp/src /tmp/missing/dst")
    assert (code, "No such file or directory" in err) == (1, True)
    assert (a.files, "/tmp/missing" in a.dirs | b.dirs) == (
        {"/tmp/src": b"x"},
        False,
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_link_to_a_hidden_name_drops_only_its_machine():
    a = FakeFiles({"/tmp/cache/x": b"x"})
    b = FakeFiles({"/tmp/secret/s": b"s"})
    b.links["/tmp/cache"] = "/tmp/secret"
    ws = two(a, b, profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}})
    agent = await ws.session("agent", profile="agent")
    done = await agent.shell("ls /tmp/cache")
    assert (done.exit_code, await done.stdout_str()) == (0, "x\n")
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_s_output_lands_on_the_machine_running_it():
    a, b = FakeFiles(), FakeFiles({"/tmp/tool": b"\x7fELF"})
    ws = two(a, b)
    assert (await run(ws, "/tmp/tool > /tmp/new"))[0] == 0
    assert (b.files.get("/tmp/new"), "/tmp/new" in a.files) == (
        b"ran\n",
        False,
    )
    await ws.close()


@pytest.mark.asyncio
async def test_cp_stays_on_the_source_s_machine():
    a, b = FakeFiles(), FakeFiles({"/tmp/src": b"payload"})
    ws = two(a, b)
    assert (await run(ws, "cp /tmp/src /tmp/dst"))[0] == 0
    assert a.files == {}
    assert b.files == {"/tmp/src": b"payload", "/tmp/dst": b"payload"}
    await ws.close()


@pytest.mark.asyncio
async def test_cp_onto_another_machine_s_name_replaces_it():
    a, b = FakeFiles({"/tmp/dst": b"old"}), FakeFiles({"/tmp/src": b"new"})
    ws = two(a, b)
    a.answer("cat > /tmp/dst", b"old")
    assert (await run(ws, "cp /tmp/src /tmp/dst"))[0] == 0
    assert ("/tmp/dst" in a.files, b.files["/tmp/dst"]) == (False, b"new")
    assert await run(ws, "cat /tmp/dst") == (0, "new", "")
    await ws.close()


@pytest.mark.asyncio
async def test_cp_through_a_machine_s_link_to_a_hidden_name_is_refused():
    a = FakeFiles({"/tmp/src": b"new", "/tmp/secret": b"s"})
    a.links["/tmp/public"] = "/tmp/secret"
    ws = two(
        a,
        FakeFiles(),
        profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}},
    )
    agent = await ws.session("agent", profile="agent")
    done = await agent.shell("cp /tmp/src /tmp/public")
    assert done.exit_code == 1
    assert sorted(a.files) == ["/tmp/secret", "/tmp/src"]
    await ws.close()


@pytest.mark.asyncio
async def test_cp_into_a_folder_only_another_machine_holds_makes_it_there():
    a, b = FakeFiles({"/tmp/d/kept": b"k"}), FakeFiles({"/tmp/src": b"s"})
    ws = two(a, b)
    assert (await run(ws, "cp /tmp/src /tmp/d/copy"))[0] == 0
    assert b.files["/tmp/d/copy"] == b"s"
    assert await run(ws, "ls /tmp/d") == (0, "copy\nkept\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_rm_r_removes_a_directory_on_every_machine():
    a = FakeFiles({"/tmp/d/x": b"1"})
    b = FakeFiles({"/tmp/d/y": b"2"})
    ws = two(a, b)
    assert (await run(ws, "rm -r /tmp/d"))[0] == 0
    assert "/tmp/d" not in a.dirs | b.dirs
    await ws.close()


@pytest.mark.asyncio
async def test_at_machine_shows_that_machine_s_files_at_the_same_path():
    a = FakeFiles({"/tmp/a.txt": b"a"})
    b = FakeFiles({"/tmp/b.txt": b"b"})
    ws = two(a, b, mounts={"/tmp": "@b"})
    assert await run(ws, "ls /tmp") == (0, "b.txt\n", "")
    await run(ws, "echo new > /tmp/new.txt")
    assert ("/tmp/new.txt" in a.files, b.files["/tmp/new.txt"]) == (
        False,
        b"new\n",
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_tree_mounts_at_another_prefix():
    a = FakeFiles({"/srv/app/main.py": b"x"})
    vfs = MachineVFS(MachineVFSConfig(machines=("a",), root="/srv"))
    ws = two(a, FakeFiles(), mounts={"/box": vfs})
    assert await run(ws, "cat /box/app/main.py") == (0, "x", "")
    await ws.close()


def test_at_machine_names_one_of_the_workspace_s_machines():
    with pytest.raises(
        ValueError, match="no machine 'gpu' \\(machines: none\\)"
    ):
        Workspace({"/tmp": "@gpu"})
    with pytest.raises(ValueError, match="a string names a machine"):
        Workspace({"/tmp": "local"})
    with pytest.raises(ValueError, match="needs a workspace with machines"):
        Workspace({"/box": MachineVFS(MachineVFSConfig())})


def test_a_workspace_without_machines_mounts_no_tmp():
    prefixes = {m.prefix for m in Workspace({})._registry.mounts()}
    assert "/tmp/" not in prefixes


def test_storage_location_names_the_machines_and_the_root():
    assert MachineVFS(MachineVFSConfig(root="/tmp/")).storage_location() == (
        "machine:*:/tmp"
    )
    vfs = MachineVFS(MachineVFSConfig(machines=("a", "b"), root="/"))
    assert vfs.storage_location() == "machine:a,b:/"


@pytest.mark.asyncio
async def test_a_machine_file_past_the_memory_room_is_refused():
    a = FakeFiles({"/tmp/big.bin": b"x" * 3_000_000})
    ws = two(a, FakeFiles(), max_memory="2MB")
    code, out, err = await run(ws, "cat /tmp/big.bin | wc -c")
    await ws.close()
    assert "memory exhausted" in err


@pytest.mark.asyncio
async def test_machine_listing_and_removal_still_work_at_the_memory_cap():
    ram = RAMVFS()
    a = FakeFiles({"/tmp/old.log": b"x"})
    ws = two(
        a,
        FakeFiles(),
        mounts={"/ram": ram},
        max_memory="2MB",
    )
    assert (await run(ws, "head -c 2097152 /dev/zero > /ram/fill"))[0] == 0
    assert await run(ws, "ls /tmp") == (0, "old.log\n", "")
    assert await run(ws, "rm /tmp/old.log") == (0, "", "")
    assert "/tmp/old.log" not in a.files
    await ws.close()


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
async def test_a_folder_on_both_machines_moves_on_each():
    a, b = FakeFiles({"/tmp/d/x": b"1"}), FakeFiles({"/tmp/d/y": b"2"})
    ws = two(a, b)
    assert (await run(ws, "mv /tmp/d /tmp/e"))[0] == 0
    assert (a.files, b.files) == ({"/tmp/e/x": b"1"}, {"/tmp/e/y": b"2"})
    assert await run(ws, "ls /tmp/e") == (0, "x\ny\n", "")
    assert await run(ws, "ls /tmp") == (0, "e\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_cp_r_of_a_folder_on_both_machines_copies_each_name_in_place():
    a, b = FakeFiles({"/tmp/d/x": b"1"}), FakeFiles({"/tmp/d/y": b"2"})
    ws = two(a, b)
    assert (await run(ws, "cp -r /tmp/d /tmp/e"))[0] == 0
    assert (a.files["/tmp/e/x"], b.files["/tmp/e/y"]) == (b"1", b"2")
    assert await run(ws, "ls /tmp/e") == (0, "x\ny\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_df_names_the_machine_and_its_path():
    said = (
        b"Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        b"overlay 100 40 60 40% /\n"
    )

    def with_df(files: FakeFiles):
        def answer(line, data):
            if line.startswith("df "):
                return RunAnswer(0, said, b"")
            return files.answer(line, data)

        return answer

    ws = Workspace(
        {"/srv": "@b"},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", with_df(FakeFiles())),
            "b": ScriptedMachine("b", with_df(FakeFiles({"/srv/k": b"k"}))),
        },
    )
    code, out, _ = await run(ws, "df /srv /tmp")
    assert code == 0
    assert [line.split()[0] for line in out.splitlines()[1:]] == [
        "b:/srv",
        "a:/tmp",
    ]
    named = await ws.shell("df /tmp", machine="b")
    assert (await named.stdout_str()).splitlines()[1].split()[0] == "b:/tmp"
    await ws.close()


class Seen(Policy):
    def __init__(self) -> None:
        self.machines: list[tuple[str, str | None]] = []

    async def pre_vfs(self, ctx):
        self.machines.append((ctx.path.virtual, ctx.machine))
        return None


@pytest.mark.asyncio
async def test_a_file_policy_is_told_the_machine_a_call_acts_on():
    seen = Seen()
    a, b = FakeFiles(), FakeFiles({"/srv/kept": b"k"})
    ws = two(
        a,
        b,
        mounts={"/srv": "@b", "/data": RAMVFS()},
        policies=[seen],
    )
    await ws.shell("cat /srv/kept; echo x > /data/f; touch /tmp/one")
    await ws.shell("touch /tmp/two", machine="b")
    told = dict(seen.machines)
    assert told["/srv/kept"] == "b"
    assert told["/data/f"] is None
    assert told["/tmp/one"] is None
    assert told["/tmp/two"] == "b"
    await ws.close()


@pytest.mark.asyncio
async def test_a_name_that_is_a_file_here_and_a_folder_there_is_the_newer():
    a, b = FakeFiles({"/tmp/k": b"file"}), FakeFiles({"/tmp/k/in": b"1"})
    ws = two(a, b)
    a.answer("cat > /tmp/k", b"newer")
    assert await run(ws, "cat /tmp/k") == (0, "newer", "")
    assert await run(ws, "rm /tmp/k") == (0, "", "")
    assert (a.files, b.files) == ({}, {"/tmp/k/in": b"1"})
    assert await run(ws, "ls /tmp/k") == (0, "in\n", "")
    code, _, err = await run(ws, "rm /tmp/k")
    assert (code, "Is a directory" in err) == (1, True)
    assert b.files == {"/tmp/k/in": b"1"}
    await ws.close()


@pytest.mark.asyncio
async def test_a_command_a_machine_runs_whole_writes_where_mirage_writes():
    a = FakeFiles({"/srv/k": b"k"}, programs=("cat",))
    b = FakeFiles({"/tmp/kept": b"old"}, programs=("cat",))
    ws = two(a, b, mounts={"/srv": "@a"})
    line = "cd /srv && cat > /tmp/kept << 'EOF'\nnew\nEOF"
    assert (await run(ws, line))[0] == 0
    assert (b.files["/tmp/kept"], "/tmp/kept" in a.files) == (b"new\n", False)
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
async def test_what_reads_a_path_named_program_s_pipe_writes_on_its_machine():
    a, b = FakeFiles(), FakeFiles({"/tmp/tool": b"\x7fELF"})
    ws = two(a, b)
    assert (await run(ws, "/tmp/tool | tee /tmp/by-tool"))[0] == 0
    assert ("/tmp/by-tool" in a.files, "/tmp/by-tool" in b.files) == (
        False,
        True,
    )
    await ws.close()


def shared(a: FakeFiles, b: FakeFiles) -> MachineVFS:
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(
        table_of(
            ScriptedMachine("a", a.answer), ScriptedMachine("b", b.answer)
        ),
        "a",
    )
    return vfs


@pytest.mark.asyncio
async def test_a_folder_one_machine_cannot_move_moves_on_none():
    a = FakeFiles({"/tmp/src/x": b"1"})
    b = FakeFiles({"/tmp/src/y": b"2", "/tmp/dst/kept": b"k"})
    with pytest.raises(OSError, match="not empty"):
        await shared(a, b).rename(spec("/src"), spec("/dst"))
    assert (a.files, sorted(b.files)) == (
        {"/tmp/src/x": b"1"},
        ["/tmp/dst/kept", "/tmp/src/y"],
    )


@pytest.mark.asyncio
async def test_rmdir_of_a_folder_one_machine_still_fills_removes_none():
    a, b = FakeFiles(), FakeFiles({"/tmp/d/x": b"1"})
    a.dirs.add("/tmp/d")
    with pytest.raises(OSError, match="not empty"):
        await shared(a, b).rmdir(spec("/d"))
    assert "/tmp/d" in a.dirs
    del b.files["/tmp/d/x"]
    await shared(a, b).rmdir(spec("/d"))
    assert "/tmp/d" not in a.dirs | b.dirs


@pytest.mark.asyncio
async def test_a_new_name_below_a_file_shown_over_a_folder_is_refused():
    a, b = FakeFiles({"/tmp/k/in": b"1"}), FakeFiles({"/tmp/k": b"f"})
    ws = two(a, b)
    b.answer("cat > /tmp/k", b"newer")
    code, _, err = await run(ws, "echo x > /tmp/k/new")
    assert (code, "Not a directory" in err) == (1, True)
    assert sorted(a.files) == ["/tmp/k/in"]
    await ws.close()
