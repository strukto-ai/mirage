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

import asyncio

import pytest

from mirage import MountMode, Workspace
from mirage.context.session_context import (
    CallerToken,
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.execution.types import MachineName
from mirage.io.types import ByteSource
from mirage.policy.base import Policy
from mirage.runtime.types import OutputFn, RunAnswer, RunResult
from mirage.types import PathSpec
from mirage.vfs.machine.config import MachineVFSConfig
from mirage.vfs.machine.machine import MachineVFS
from mirage.vfs.ram import RAMVFS
from tests.fixtures.machine import ScriptedMachine, failed, table_of
from tests.fixtures.machine_files import FakeFiles, run, spec, two


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
async def test_a_machine_file_past_the_memory_room_streams():
    a = FakeFiles({"/tmp/big.bin": b"x" * 3_000_000})
    ws = two(a, FakeFiles(), max_memory="2MB")
    assert await run(ws, "cat /tmp/big.bin | wc -c") == (0, "3000000\n", "")
    assert await run(ws, "wc -c < /tmp/big.bin") == (0, "3000000\n", "")
    await ws.close()


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
async def test_three_machines_read_as_one_folder():
    a = FakeFiles({"/tmp/x": b"a", "/tmp/d/1": b"1"})
    b = FakeFiles({"/tmp/x": b"b", "/tmp/d/2": b"2"})
    c = FakeFiles(
        {
            "/tmp/x": b"c",
            "/tmp/d/3": b"3",
            "/tmp/only/kept": b"k",
            "/tmp/src": b"new",
        }
    )
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
            "c": ScriptedMachine("c", c.answer),
        },
    )
    c.answer("cat > /tmp/x", b"last")
    assert await run(ws, "cat /tmp/x") == (0, "last", "")
    b.answer("cat > /tmp/x", b"later")
    assert await run(ws, "cat /tmp/x") == (0, "later", "")
    assert await run(ws, "ls /tmp/d") == (0, "1\n2\n3\n", "")
    assert (await run(ws, "echo n > /tmp/only/new"))[0] == 0
    assert ["/tmp/only/new" in m.files for m in (a, b, c)] == [
        False,
        False,
        True,
    ]
    assert (await run(ws, "mv /tmp/d /tmp/e"))[0] == 0
    assert [sorted(f for f in m.files if "/e/" in f) for m in (a, b, c)] == [
        ["/tmp/e/1"],
        ["/tmp/e/2"],
        ["/tmp/e/3"],
    ]
    assert (await run(ws, "cp /tmp/src /tmp/x"))[0] == 0
    assert ["/tmp/x" in m.files for m in (a, b, c)] == [False, False, True]
    assert await run(ws, "cat /tmp/x") == (0, "new", "")
    assert await run(ws, "rm /tmp/x") == (0, "", "")
    assert not any("/tmp/x" in m.files for m in (a, b, c))
    await ws.close()


def shared(*files: FakeFiles) -> MachineVFS:
    """A mount of /tmp over machines a, b, c, ... holding ``files``."""
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(
        table_of(
            *(
                ScriptedMachine(name, one.answer)
                for name, one in zip("abcdef", files)
            )
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
async def test_mv_makes_no_folder_where_another_machine_shows_a_file():
    a, b = FakeFiles({"/tmp/src": b"x"}), FakeFiles({"/tmp/p": b"file"})
    with pytest.raises(OSError):
        await shared(a, b).rename(spec("/src"), spec("/p/dst"))
    assert ("/tmp/p" in a.dirs, sorted(a.files)) == (False, ["/tmp/src"])


@pytest.mark.asyncio
async def test_mv_under_a_file_shown_over_an_older_folder_moves_nothing():
    a = FakeFiles({"/tmp/src": b"x"})
    b = FakeFiles({"/tmp/p/kept": b"k"})
    c = FakeFiles({"/tmp/p": b"file"})
    c.answer("cat > /tmp/p", b"newer")
    with pytest.raises(NotADirectoryError):
        await shared(a, b, c).rename(spec("/src"), spec("/p/dst"))
    assert ("/tmp/p" in a.dirs, sorted(a.files)) == (False, ["/tmp/src"])
    assert sorted(b.files) == ["/tmp/p/kept"]


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


CROSSING = (
    "machine a's bytes do not go to machine b: copy them through a store"
)


def apart() -> tuple[FakeFiles, FakeFiles, Workspace]:
    """Two machines, each with a folder of its own, sharing ``/tmp``,
    and a store at ``/ram``."""
    a = FakeFiles({"/srv/a/k": b"key\n"}, programs=("gen", "cat"))
    b = FakeFiles(programs=("sink", "cat"))
    b.dirs.add("/srv/b")
    ws = two(a, b, mounts={"/srv/a": "@a", "/srv/b": "@b", "/ram": RAMVFS()})
    return a, b, ws


@pytest.mark.asyncio
async def test_a_copy_from_one_machine_to_another_is_refused():
    a, b, ws = apart()
    for verb in ("cp", "mv"):
        done = await ws.shell(f"{verb} /srv/a/k /srv/b/k")
        assert done.exit_code == 1
        assert await done.stderr_str() == (
            f"{verb}: cannot create regular file '/srv/b/k':"
            " Permission denied\n"
        )
        assert done.decision is not None
        assert done.decision.reason == CROSSING
    assert "/srv/b/k" not in b.files
    assert a.files["/srv/a/k"] == b"key\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_copy_into_a_folder_its_machine_shares_lands_with_its_source():
    a, b, ws = apart()
    assert await run(ws, "cp /srv/a/k /tmp/k") == (0, "", "")
    assert a.files["/tmp/k"] == b"key\n"
    assert "/tmp/k" not in b.files
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_file_goes_to_a_store_and_on_to_another_machine():
    a, b, ws = apart()
    assert await run(ws, "cp /srv/a/k /ram/k") == (0, "", "")
    assert await run(ws, "cp /ram/k /srv/b/k") == (0, "", "")
    assert b.files["/srv/b/k"] == b"key\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_s_output_never_lands_on_another_machine():
    a, b, ws = apart()
    for line, target in (
        ("gen > /srv/b/out", "/srv/b/out"),
        ("gen 2> /srv/b/err", "/srv/b/err"),
    ):
        done = await ws.shell(line)
        assert done.exit_code == 1
        assert await done.stderr_str() == (
            f"bash: line 1: {target}: Permission denied\n"
        )
        assert done.decision is not None
        assert done.decision.reason == CROSSING
    assert await run(ws, "gen > /tmp/out") == (0, "", "")
    assert a.ran == ["gen"]
    assert a.files["/tmp/out"] == b"ran\n"
    assert ("/srv/b/out" in b.files, "/tmp/out" in b.files) == (False, False)
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_reads_no_file_of_another_machine():
    a, b, ws = apart()
    done = await ws.shell("sink < /srv/a/k")
    assert done.exit_code == 1
    assert await done.stderr_str() == (
        "bash: line 1: /srv/a/k: Permission denied\n"
    )
    assert done.decision is not None
    assert done.decision.reason == CROSSING
    assert b.ran == []
    assert await run(ws, "wc -c < /srv/a/k") == (0, "4\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_command_handed_to_a_machine_lands_its_output_there():
    a, b, ws = apart()
    assert await run(ws, "cat /srv/a/k > /tmp/cat") == (0, "", "")
    assert a.files["/tmp/cat"] == b"ran\n"
    assert "/tmp/cat" not in b.files
    done = await ws.shell("cat /srv/a/k > /srv/b/cat")
    assert done.exit_code == 1
    assert await done.stderr_str() == (
        "bash: line 1: /srv/b/cat: Permission denied\n"
    )
    assert a.ran == ["cat /srv/a/k"]
    assert "/srv/b/cat" not in b.files
    await ws.close()


class Judged(Policy):
    """A post_vfs policy, under which a copy goes by a read and a write."""

    async def post_vfs(self, ctx):
        return None


@pytest.mark.asyncio
async def test_a_copy_by_a_read_and_a_write_keeps_its_bytes_on_their_machine():
    a = FakeFiles({"/srv/a/k": b"key\n"})
    b = FakeFiles()
    b.dirs.add("/srv/b")
    ws = two(
        a, b, mounts={"/srv/a": "@a", "/srv/b": "@b"}, policies=[Judged()]
    )
    for verb in ("cp", "mv"):
        done = await ws.shell(f"{verb} /srv/a/k /srv/b/k")
        assert done.exit_code == 1
        assert await done.stderr_str() == (
            f"{verb}: cannot create regular file '/srv/b/k':"
            " Permission denied\n"
        )
    assert "/srv/b/k" not in b.files
    assert await run(ws, "cp /srv/a/k /tmp/k") == (0, "", "")
    assert (a.files["/tmp/k"], "/tmp/k" in b.files) == (b"key\n", False)
    await ws.close()


@pytest.mark.asyncio
async def test_a_copy_by_a_read_and_a_write_lands_as_a_direct_copy_does():
    a = FakeFiles({"/srv/a/k": b"new\n"})
    b = FakeFiles({"/tmp/k": b"old\n"})
    b.dirs.add("/tmp/only")
    b.written["/tmp/k"] = 2 * 10**9
    ws = two(a, b, mounts={"/srv/a": "@a"}, policies=[Judged()])
    assert await run(ws, "cp /srv/a/k /tmp/only/k") == (0, "", "")
    assert (a.files["/tmp/only/k"], "/tmp/only/k" in b.files) == (
        b"new\n",
        False,
    )
    assert await run(ws, "cp /srv/a/k /tmp/k") == (0, "", "")
    assert "/tmp/k" not in b.files
    assert await run(ws, "cat /tmp/k") == (0, "new\n", "")
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "policies", "said"),
    [
        (
            "cp /srv/a/k /tmp/public/missing/k",
            policies,
            "cp: cannot create regular file '/tmp/public/missing/k':"
            " No such file or directory\n",
        )
        for policies in ([], [Judged()])
    ]
    + [
        (
            "gen > /tmp/public/missing/k",
            [],
            "bash: line 1: /tmp/public/missing/k: No such file or directory\n",
        )
    ],
)
async def test_a_write_never_makes_a_folder_through_a_link_to_a_hidden_one(
    line, policies, said
):
    a = FakeFiles(
        {"/srv/a/k": b"key\n", "/tmp/secret/s": b"s"}, programs=("gen",)
    )
    a.links["/tmp/public"] = "/tmp/secret"
    b = FakeFiles()
    b.dirs.update({"/tmp/public", "/tmp/public/missing"})
    ws = two(
        a,
        b,
        mounts={"/srv/a": "@a"},
        policies=policies,
        profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}},
    )
    agent = await ws.session("agent", profile="agent")
    done = await agent.shell(line)
    assert (done.exit_code, await done.stderr_str()) == (1, said)
    assert sorted(a.files) == ["/srv/a/k", "/tmp/secret/s"]
    assert not any(d.endswith("/missing") for d in a.dirs)
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_s_output_lands_on_its_machine_as_a_copy_does():
    a = FakeFiles(programs=("gen",))
    b = FakeFiles({"/tmp/k": b"old\n"})
    b.dirs.add("/tmp/only")
    b.written["/tmp/k"] = 2 * 10**9
    ws = two(a, b)
    assert await run(ws, "gen > /tmp/only/out") == (0, "", "")
    assert (a.files["/tmp/only/out"], "/tmp/only/out" in b.files) == (
        b"ran\n",
        False,
    )
    assert await run(ws, "gen > /tmp/k") == (0, "", "")
    assert "/tmp/k" not in b.files
    assert await run(ws, "cat /tmp/k") == (0, "ran\n", "")
    await ws.close()


def running_on(name: str) -> CallerToken:
    """Bind a program running on machine ``name`` as the caller.

    Args:
        name (str): the machine.
    """
    return bind_caller(
        current_caller().changed({"machine": MachineName("scripted", name)})
    )


async def write_on(
    name: str, vfs: MachineVFS, path: PathSpec, data: ByteSource
) -> None:
    """Write a name as a program's ``>`` on machine ``name`` does.

    Args:
        name (str): the program's machine.
        vfs (MachineVFS): the mount.
        path (PathSpec): the name.
        data (ByteSource): what the program writes.
    """
    token = running_on(name)
    try:
        await vfs.write(path, data)
    finally:
        reset_caller(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("landing", ["write", "copy"])
async def test_a_landing_leaves_another_machine_s_live_write(landing):
    a = FakeFiles({"/tmp/src": b"from a\n"})
    b = FakeFiles({"/tmp/k": b"old\n"})
    vfs = shared(a, b)
    pulled, released = asyncio.Event(), asyncio.Event()

    async def slow():
        pulled.set()
        await released.wait()
        yield b"from b\n"

    writing = asyncio.create_task(write_on("b", vfs, spec("/k"), slow()))
    await pulled.wait()
    if landing == "write":
        await write_on("a", vfs, spec("/k"), b"from a\n")
    else:
        await vfs.copy(spec("/src"), spec("/k"))
    assert (a.files["/tmp/k"], "/tmp/k" in b.files) == (b"from a\n", True)
    released.set()
    await writing
    assert ("/tmp/k" in a.files, b.files["/tmp/k"]) == (False, b"from b\n")


@pytest.mark.asyncio
async def test_a_live_write_that_fails_leaves_the_copy_landed_meanwhile():
    a, b = FakeFiles(), FakeFiles({"/tmp/k": b"old\n"})
    b.written["/tmp/k"] = 2 * 10**9
    vfs = shared(a, b)
    pulled, released = asyncio.Event(), asyncio.Event()

    async def failing():
        pulled.set()
        await released.wait()
        raise OSError(5, "Input/output error")
        yield b""

    writing = asyncio.create_task(write_on("b", vfs, spec("/k"), failing()))
    await pulled.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    released.set()
    with pytest.raises(OSError):
        await writing
    assert (a.files["/tmp/k"], "/tmp/k" in b.files) == (b"from a\n", False)


@pytest.mark.asyncio
async def test_the_write_ending_last_is_the_copy_kept():
    a, b = FakeFiles(), FakeFiles({"/tmp/k": b"old\n"})
    vfs = shared(a, b)
    pulled, released = asyncio.Event(), asyncio.Event()

    async def slow():
        pulled.set()
        await released.wait()
        yield b"from b\n"

    writing = asyncio.create_task(vfs.write(spec("/k"), slow()))
    await pulled.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    released.set()
    await writing
    assert ("/tmp/k" in a.files, b.files["/tmp/k"]) == (False, b"from b\n")


@pytest.mark.asyncio
async def test_writes_ending_together_on_two_machines_leave_one_copy():
    machines = {"a": FakeFiles(), "b": FakeFiles()}
    vfs = shared(*machines.values())
    released = asyncio.Event()
    pulled = {name: asyncio.Event() for name in machines}

    async def held(name):
        pulled[name].set()
        await released.wait()
        yield f"from {name}\n".encode()

    writes = [
        asyncio.create_task(write_on(name, vfs, spec("/k"), held(name)))
        for name in machines
    ]
    await asyncio.gather(*(event.wait() for event in pulled.values()))
    released.set()
    await asyncio.gather(*writes)
    kept = {
        name: files.files["/tmp/k"]
        for name, files in machines.items()
        if "/tmp/k" in files.files
    }
    assert len(kept) == 1
    ((name, data),) = kept.items()
    assert data == f"from {name}\n".encode()


class Gated(ScriptedMachine):
    """A machine whose next line holding every part ``armed`` names waits
    for ``go``, setting ``held`` as it starts to wait."""

    def __init__(self, name: str, answer) -> None:
        super().__init__(name, answer)
        self.armed: tuple[str, ...] = ()
        self.held = asyncio.Event()
        self.go = asyncio.Event()

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        line = " ".join(argv)
        if self.armed and all(part in line for part in self.armed):
            self.armed = ()
            self.held.set()
            await self.go.wait()
        return await super()._exec_argv(argv, stdin, env, cwd, output, errors)


@pytest.mark.asyncio
async def test_a_settling_keeps_a_copy_landed_while_it_looks():
    a_files, b_files = FakeFiles(), FakeFiles()
    a = Gated("a", a_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(a, ScriptedMachine("b", b_files.answer)), "a")
    a.armed = ("/tmp/k", "-maxdepth 0")
    first = asyncio.create_task(write_on("b", vfs, spec("/k"), b"from b\n"))
    await a.held.wait()
    await write_on("a", vfs, spec("/k"), b"from a\n")
    a.go.set()
    await first
    assert (a_files.files["/tmp/k"], "/tmp/k" in b_files.files) == (
        b"from a\n",
        False,
    )


@pytest.mark.asyncio
async def test_a_removal_never_takes_a_copy_written_after_it_began():
    a_files, b_files = FakeFiles(), FakeFiles({"/tmp/k": b"old\n"})
    b = Gated("b", b_files.answer)
    vfs = MachineVFS(MachineVFSConfig(root="/tmp"))
    vfs.bind_machines(table_of(ScriptedMachine("a", a_files.answer), b), "a")
    b.armed = ("rm --", "/tmp/k")
    first = asyncio.create_task(write_on("a", vfs, spec("/k"), b"from a\n"))
    await b.held.wait()
    second = asyncio.create_task(write_on("b", vfs, spec("/k"), b"from b\n"))
    await asyncio.wait({second}, timeout=0.2)
    b.go.set()
    await asyncio.gather(first, second)
    assert ("/tmp/k" in a_files.files, b_files.files.get("/tmp/k")) == (
        False,
        b"from b\n",
    )
