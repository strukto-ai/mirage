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
from mirage.policy.base import Policy
from mirage.policy.types import Route
from mirage.runtime.types import RunAnswer
from tests.fixtures.machine import ScriptedMachine, failed
from tests.fixtures.machine_files import FakeFiles, two


class Seen(Policy):
    async def pre_vfs(self, ctx):
        return None


@pytest.mark.asyncio
async def test_a_program_only_a_later_machine_has_runs_there():
    a, b = FakeFiles(programs=("both",)), FakeFiles(programs=("both", "smi"))
    ws = two(a, b, mounts={"/data": RAMVFS()})
    assert (await ws.shell("smi -L")).exit_code == 0
    assert (await ws.shell("both")).exit_code == 0
    assert (a.ran, b.ran) == (["both"], ["smi -L"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_no_machine_has_is_not_found_on_the_first():
    a, b = FakeFiles(), FakeFiles()
    ws = two(a, b)
    await ws.shell("nowhere")
    assert (a.ran, b.ran) == (["nowhere"], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_named_machine_runs_the_program_whoever_has_it():
    a, b = FakeFiles(), FakeFiles(programs=("smi",))
    ws = two(a, b)
    await ws.shell("smi", machine="a")
    assert (a.ran, b.ran) == (["smi"], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_both_have_runs_where_the_folder_is():
    a = FakeFiles({"/tmp/both/k": b"k"}, programs=("py",))
    b = FakeFiles(
        {"/srv/k": b"k", "/tmp/only/k": b"k", "/tmp/both/k": b"k"},
        programs=("py",),
    )
    ws = two(a, b, mounts={"/srv": "@b"})
    await ws.shell("cd /srv && py one")
    await ws.shell("cd /tmp/only && py two")
    await ws.shell("cd /tmp/both && py three")
    assert (a.ran, b.ran) == (["py three"], ["py one", "py two"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_both_have_runs_where_the_path_it_names_is():
    a = FakeFiles({"/tmp/both.py": b"a"}, programs=("py",))
    b = FakeFiles(
        {"/srv/job.py": b"j", "/tmp/only.py": b"o", "/tmp/both.py": b"b"},
        programs=("py",),
    )
    ws = two(a, b, mounts={"/srv": "@b", "/data": RAMVFS()})
    await ws.shell("cd /data && py /srv/job.py")
    await ws.shell("py /tmp/only.py")
    await ws.shell("py /tmp/both.py")
    await ws.shell("py /tmp/new.py")
    assert a.ran == ["py /tmp/both.py", "py /tmp/new.py"]
    assert b.ran == ["py /srv/job.py", "py /tmp/only.py"]
    await ws.close()


@pytest.mark.asyncio
async def test_the_folder_decides_before_the_path():
    a = FakeFiles({"/srv/a/k": b"k"}, programs=("py",))
    b = FakeFiles({"/srv/b/job.py": b"j"}, programs=("py",))
    ws = two(a, b, mounts={"/srv/a": "@a", "/srv/b": "@b"})
    await ws.shell("cd /srv/a && py /srv/b/job.py")
    assert (a.ran, b.ran) == (["py /srv/b/job.py"], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_folder_s_machine_without_the_program_leaves_it_to_another():
    a = FakeFiles({"/srv/k": b"k"})
    b = FakeFiles(programs=("smi",))
    ws = two(a, b, mounts={"/srv": "@a"})
    await ws.shell("cd /srv && smi")
    assert (a.ran, b.ran) == ([], ["smi"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_s_redirect_lands_on_the_machine_search_picked():
    a, b = FakeFiles(), FakeFiles(programs=("smi",))
    ws = two(a, b)
    assert (await ws.shell("smi > /tmp/out")).exit_code == 0
    assert ("/tmp/out" in a.files, "/tmp/out" in b.files) == (False, True)
    await ws.close()


@pytest.mark.asyncio
async def test_what_reads_a_searched_program_s_pipe_writes_on_its_machine():
    a, b = FakeFiles(), FakeFiles(programs=("smi",))
    ws = two(a, b)
    assert (await ws.shell("smi | tee /tmp/piped")).exit_code == 0
    assert (await ws.shell("nice smi | tee /tmp/wrapped")).exit_code == 0
    assert sorted(b.files) == ["/tmp/piped", "/tmp/wrapped"]
    assert a.files == {}
    await ws.close()


@pytest.mark.asyncio
async def test_a_wrapped_program_is_searched_for_too():
    a, b = FakeFiles(), FakeFiles(programs=("smi",))
    ws = two(a, b)
    assert (await ws.shell("nice smi > /tmp/out")).exit_code == 0
    assert (a.ran, b.ran) == ([], ["nice smi"])
    assert ("/tmp/out" in a.files, "/tmp/out" in b.files) == (False, True)
    await ws.close()


@pytest.mark.asyncio
async def test_a_lookup_asks_the_machine_search_order_picks():
    a, b = FakeFiles(), FakeFiles(programs=("smi",))
    ws = two(a, b)
    await ws.shell("which smi")
    assert (a.ran, b.ran) == ([], ["which smi"])
    await ws.close()


@pytest.mark.asyncio
async def test_under_a_file_policy_the_first_machine_with_it_runs_it():
    a = FakeFiles(programs=("py",))
    b = FakeFiles({"/tmp/only.py": b"o"}, programs=("py", "smi"))
    ws = two(a, b, policies=[Seen()])
    await ws.shell("py /tmp/only.py")
    await ws.shell("smi")
    assert (a.ran, b.ran) == (["py /tmp/only.py"], ["smi"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_installed_since_the_last_look_is_found():
    a, b = FakeFiles(), FakeFiles()
    ws = two(a, b)
    await ws.shell("tool")
    b.programs.add("tool")
    await ws.shell("tool")
    assert (a.ran, b.ran) == (["tool"], ["tool"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_is_looked_for_on_the_path_the_session_set():
    second = ScriptedMachine("b", FakeFiles(programs=("smi",)).answer)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": ScriptedMachine("a", FakeFiles().answer), "b": second},
    )
    await ws.shell("export PATH=/opt/mr:/usr/bin; smi")
    assert second.lines == [
        "PATH='/opt/mr:/usr/bin' command -v smi >/dev/null 2>&1",
        "smi",
    ]
    await ws.close()


@pytest.mark.asyncio
async def test_one_machine_asks_nothing_before_it_runs_a_program():
    machine = ScriptedMachine("a", FakeFiles().answer)
    ws = Workspace({}, mode=MountMode.WRITE, machines={"a": machine})
    await ws.shell("smi")
    assert machine.lines == ["smi"]
    await ws.close()


class Down(ScriptedMachine):
    """A machine that cannot be reached."""

    async def connect(self) -> None:
        raise ConnectionError("unreachable")


@pytest.mark.asyncio
@pytest.mark.parametrize("down", ["a", "b"])
async def test_a_machine_that_is_down_keeps_no_program_off_another(down):
    files = FakeFiles(programs=("smi",))
    machines = {
        name: Down(name, FakeFiles().answer)
        if name == down
        else ScriptedMachine(name, files.answer)
        for name in ("a", "b")
    }
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, machines=machines
    )
    await ws.shell("cd /data && smi")
    assert files.ran == ["smi"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_pipe_s_writer_is_placed_by_the_paths_it_names():
    a = FakeFiles(programs=("py",))
    b = FakeFiles({"/srv/job.py": b"j"}, programs=("py",))
    ws = two(a, b, mounts={"/srv": "@b"})
    assert (await ws.shell("py /srv/job.py | tee /tmp/piped")).exit_code == 0
    assert (a.ran, b.ran) == ([], ["py /srv/job.py"])
    assert ("/tmp/piped" in a.files, "/tmp/piped" in b.files) == (False, True)
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_is_looked_for_on_the_path_its_own_prefix_sets():
    second = ScriptedMachine("b", FakeFiles(programs=("smi",)).answer)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": ScriptedMachine("a", FakeFiles().answer), "b": second},
    )
    await ws.shell("PATH=/opt/bin smi")
    assert second.lines == [
        "PATH=/opt/bin command -v smi >/dev/null 2>&1",
        "smi",
    ]
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_removed_since_the_last_look_is_looked_for_again():
    a, b = FakeFiles(programs=("tool",)), FakeFiles(programs=("tool",))

    def first(line: str, data: bytes | None) -> RunAnswer:
        if line == "tool" and "tool" not in a.programs:
            return failed(b"tool: command not found\n", 127)
        return a.answer(line, data)

    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", first),
            "b": ScriptedMachine("b", b.answer),
        },
    )
    await ws.shell("tool")
    a.programs.discard("tool")
    assert (await ws.shell("tool")).exit_code == 127
    assert (await ws.shell("tool")).exit_code == 0
    assert (a.ran, b.ran) == (["tool"], ["tool"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_path_that_leans_on_the_folder_is_looked_on_from_it():
    files = FakeFiles({"/tmp/w/k": b"k"}, programs=("smi",))
    second = ScriptedMachine("b", files.answer)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": ScriptedMachine("a", FakeFiles().answer), "b": second},
    )
    await ws.shell("cd /tmp/w && PATH=bin:/usr/bin smi")
    looked = "PATH='bin:/usr/bin' command -v smi >/dev/null 2>&1"
    assert f"cd -- /tmp/w 2>/dev/null && {looked}" in second.lines
    assert files.ran == ["smi"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_usr_bin_path_runs_its_program_where_search_finds_it():
    a, b = FakeFiles(), FakeFiles(programs=("tool",))
    ws = two(a, b)
    await ws.shell("/usr/bin/tool -x")
    assert (a.ran, b.ran) == ([], ["tool -x"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_lookup_past_a_function_asks_the_machine_search_picks():
    a, b = FakeFiles(), FakeFiles(programs=("smi",))
    ws = two(a, b)
    await ws.shell("smi() { :; }; which smi")
    assert (a.ran, b.ran) == ([], ["which smi"])
    await ws.close()


class ByOutput(Policy):
    """Routes a command to machine ``b`` once it writes ``/tmp/out``."""

    def pre_command(self, ctx):
        wrote = any(p.virtual == "/tmp/out" for p in ctx.paths)
        return Route(machine="b") if wrote else None


@pytest.mark.asyncio
async def test_a_route_that_comes_with_the_redirect_decides_over_the_search():
    a, b = FakeFiles(programs=("tool",)), FakeFiles(programs=("tool",))
    ws = two(a, b, policies=[ByOutput()])
    await ws.shell("tool")
    await ws.shell("tool > /tmp/out")
    assert (a.ran, b.ran) == (["tool"], ["tool"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_that_is_down_does_not_hide_who_holds_a_path():
    a = FakeFiles(programs=("smi",))
    b = FakeFiles({"/tmp/only.txt": b"o"}, programs=("smi",))
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": ScriptedMachine("a", a.answer),
            "b": ScriptedMachine("b", b.answer),
            "c": Down("c", FakeFiles().answer),
        },
    )
    await ws.shell("smi /tmp/only.txt")
    assert (a.ran, b.ran) == ([], ["smi /tmp/only.txt"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_prefix_that_sets_path_through_a_reference_is_the_path_searched():
    second = ScriptedMachine("b", FakeFiles(programs=("smi",)).answer)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": ScriptedMachine("a", FakeFiles().answer), "b": second},
    )
    await ws.shell("declare -n P=PATH; P=/opt/bin smi")
    assert second.lines == [
        "PATH=/opt/bin command -v smi >/dev/null 2>&1",
        "smi",
    ]
    await ws.close()


class Serving(ScriptedMachine):
    """A machine that is served the session's restricted view."""

    def serves_session(self, restricted_mounts: tuple[str, ...]) -> bool:
        return True


@pytest.mark.asyncio
async def test_a_machine_that_refuses_the_session_is_no_candidate():
    a, b = FakeFiles(), FakeFiles(programs=("smi",))
    second = ScriptedMachine("b", b.answer)
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={"a": Serving("a", a.answer), "b": second},
        profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}},
    )
    agent = await ws.session("agent", profile="agent")
    await agent.shell("smi")
    assert (a.ran, second.lines) == (["smi"], [])
    await ws.close()


@pytest.mark.asyncio
async def test_a_usr_bin_path_is_searched_for_past_a_function_of_its_name():
    a, b = FakeFiles(), FakeFiles(programs=("tool",))
    ws = two(a, b)
    await ws.shell("tool() { :; }; /usr/bin/tool -x")
    assert (a.ran, b.ran) == ([], ["tool -x"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_that_is_down_does_not_hide_who_holds_a_path_under_a_hide():
    a = FakeFiles(programs=("smi",))
    b = FakeFiles({"/tmp/only.txt": b"o"}, programs=("smi",))
    ws = Workspace(
        {},
        mode=MountMode.WRITE,
        machines={
            "a": Serving("a", a.answer),
            "b": Serving("b", b.answer),
            "c": Down("c", FakeFiles().answer),
        },
        profiles={"agent": {"paths": {"hide": ["/tmp/secret"]}}},
    )
    agent = await ws.session("agent", profile="agent")
    await agent.shell("smi /tmp/only.txt")
    assert (a.ran, b.ran) == ([], ["smi /tmp/only.txt"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_program_reading_a_pipe_runs_on_its_writer_s_machine():
    a = FakeFiles(programs=("both",))
    b = FakeFiles(programs=("gen", "both"))
    ws = two(a, b)
    assert (await ws.shell("gen | both")).exit_code == 0
    assert (await ws.shell("both")).exit_code == 0
    assert (a.ran, b.ran) == (["both"], ["gen", "both"])
    await ws.close()


@pytest.mark.asyncio
async def test_a_middle_stage_is_placed_where_its_own_writer_put_it():
    a = FakeFiles(programs=("filter",))
    b = FakeFiles(programs=("gen", "filter", "sink"))
    ws = two(a, b)
    assert (await ws.shell("gen | filter | sink")).exit_code == 0
    assert (a.ran, b.ran) == ([], ["gen", "filter", "sink"])
    await ws.close()
