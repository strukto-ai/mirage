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
from mirage.vfs.machine.config import MachineVFSConfig
from mirage.vfs.machine.machine import MachineVFS
from tests.fixtures.machine import ScriptedMachine
from tests.fixtures.machine_files import FakeFiles


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
async def test_a_name_on_both_machines_is_refused_as_ambiguous():
    ws = two(FakeFiles({"/tmp/x": b"a"}), FakeFiles({"/tmp/x": b"b"}))
    code, _, err = await run(ws, "cat /tmp/x")
    assert code == 1
    assert "on several machines: a, b" in err
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
    ws = two(a, b)
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
async def test_cp_onto_another_machine_moves_the_bytes_through_mirage():
    a, b = FakeFiles(), FakeFiles({"/tmp/src": b"payload"})
    ws = two(a, b)
    assert (await run(ws, "cp /tmp/src /tmp/dst"))[0] == 0
    assert a.files == {"/tmp/dst": b"payload"}
    assert b.files == {"/tmp/src": b"payload"}
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
async def test_at_local_shows_the_machines_files_at_the_same_path():
    a = FakeFiles({"/srv/app/main.py": b"x"})
    ws = two(a, FakeFiles(), mounts={"/srv": "@local"})
    assert await run(ws, "ls /srv/app") == (0, "main.py\n", "")
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_tree_mounts_at_another_prefix():
    a = FakeFiles({"/srv/app/main.py": b"x"})
    vfs = MachineVFS(MachineVFSConfig(machines=("a",), root="/srv"))
    ws = two(a, FakeFiles(), mounts={"/box": vfs})
    assert await run(ws, "cat /box/app/main.py") == (0, "x", "")
    await ws.close()


def test_at_local_needs_machines():
    with pytest.raises(ValueError, match="@local needs a workspace"):
        Workspace({"/srv": "@local"})
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
