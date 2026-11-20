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

import re
import shlex
from dataclasses import replace

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.machine.constants import RUN_PROGRAM_AT, is_run
from mirage.policy import Deny
from mirage.policy.base import Policy
from mirage.runtime.types import RunAnswer, RunResult
from tests.fixtures.machine import ScriptedMachine, failed, ok
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


def _bash_line(line: str) -> str | None:
    """The command a lookup runs in the machine's bash, None for a line
    the machine runs as it is."""
    found = re.search(r"exec /bin/bash -c ('[^']*'|\S+); fi", line)
    return None if found is None else shlex.split(found.group(1))[0]


def asking(files: FakeFiles, found: dict[str, list[str]]):
    """A machine whose `which` and bash `type`/`command` find each name of
    ``found`` at its paths, first first, and whose files are ``files``."""

    def answer(line: str, data: bytes | None) -> RunAnswer:
        inner = _bash_line(line)
        words = shlex.split(line if inner is None else inner)
        if words[0] not in ("which", "type", "command"):
            return files.answer(line, data)
        letters = words[1][1:] if words[1].startswith("-") else ""
        name = words[-1]
        paths = found.get(name, [])
        if not paths:
            return failed(b"", 1)
        if "a" not in letters:
            paths = paths[:1]
        if words[0] == "type" and "t" in letters:
            text = "file\n" * len(paths)
        elif (words[0] == "type" and not set(letters) & set("pP")) or (
            words[0] == "command" and "V" in letters
        ):
            text = "".join(f"{name} is {path}\n" for path in paths)
        else:
            text = "".join(f"{path}\n" for path in paths)
        return ok(text.encode())

    return answer


def looked_up(machine: ScriptedMachine) -> list[str]:
    return [
        line
        for line in machine.lines
        if line.startswith("which ") or _bash_line(line) is not None
    ]


async def lookup_ws(found, captures=None, files=None) -> tuple:
    files = files or FakeFiles()
    dev = ScriptedMachine("dev", asking(files, found))
    if captures is not None:
        dev.config = replace(dev.config, captures=tuple(captures))
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        machines={"dev": dev},
    )
    return ws, dev


@pytest.mark.asyncio
async def test_a_lookup_of_a_name_mirage_lacks_asks_the_machine_that_runs_it():
    ws, dev = await lookup_ws({"perl": ["/usr/bin/perl", "/bin/perl"]})
    assert await out(ws, "which perl") == "/usr/bin/perl\n"
    assert await out(ws, "type perl") == "perl is /usr/bin/perl\n"
    assert await out(ws, "type -t perl") == "file\n"
    assert await out(ws, "command -v perl") == "/usr/bin/perl\n"
    assert await out(ws, "command -V perl") == "perl is /usr/bin/perl\n"
    # Without the machine's disk in Mirage, both of its paths run perl
    # by name, through the one /usr/bin file.
    assert await out(ws, "type -a perl") == "perl is /usr/bin/perl\n"
    assert looked_up(dev)[0] == "which perl"
    assert "exec /bin/bash -c 'type perl'" in looked_up(dev)[1]
    await ws.close()


@pytest.mark.asyncio
async def test_a_name_mirage_runs_is_mirage_s_to_answer_and_asks_no_machine():
    ws, dev = await lookup_ws({"grep": ["/usr/bin/grep"]})
    assert await out(ws, "which grep") == "/usr/bin/grep\n"
    assert await out(ws, "type cd") == "cd is a shell builtin\n"
    assert looked_up(dev) == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_name_the_machine_lacks_is_not_found():
    ws, _ = await lookup_ws({})
    which = await ws.shell("which nosuch")
    assert (await which.stdout_str(), which.exit_code) == ("", 1)
    typed = await ws.shell("type nosuch")
    assert typed.exit_code == 1
    assert (
        await typed.stderr_str() == "bash: line 1: type: nosuch: not found\n"
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_function_shadows_the_machine_for_type_but_not_for_which():
    ws, dev = await lookup_ws({"perl": ["/usr/bin/perl"]})
    await ws.shell("perl() { :; }")
    assert (await out(ws, "type -t perl")) == "function\n"
    assert looked_up(dev) == []
    assert await out(ws, "which perl") == "/usr/bin/perl\n"
    assert await out(ws, "type -P perl") == "/usr/bin/perl\n"
    assert (await out(ws, "type -at perl")) == "function\nfile\n"
    assert await out(ws, "type -f perl") == "perl is /usr/bin/perl\n"
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_that_refuses_the_session_s_runs_is_asked_nothing():
    ws, dev = await lookup_ws({"perl": ["/usr/bin/perl"]})
    ws.create_session(
        "restricted", profile={"paths": {"hide": ["/data/secret"]}}
    )
    which = await ws.shell("which perl", session_id="restricted")
    assert (await which.stdout_str(), which.exit_code) == ("", 1)
    ran = await ws.shell("perl -v", session_id="restricted")
    assert ran.exit_code == 126
    assert looked_up(dev) == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_name_with_a_leading_dash_reaches_the_machine_after_dashes():
    ws, dev = await lookup_ws({"-tool": ["/usr/local/bin/-tool"]})
    assert await out(ws, "which -- -tool") == "/usr/bin/-tool\n"
    assert await out(ws, "type -t -- -tool") == "file\n"
    assert looked_up(dev)[0] == "which -- -tool"
    assert "bash -c 'type -t -- -tool'; fi" in looked_up(dev)[1]
    assert looked_up(dev)[1].endswith("exec /bin/sh -c 'type -t -tool'")
    await ws.close()


class Exported(ScriptedMachine):
    """A machine that keeps the environment each lookup ran in."""

    def __init__(self, name: str, answer) -> None:
        super().__init__(name, answer)
        self.envs: list[dict[str, str]] = []

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if argv[-1].startswith("which "):
            self.envs.append({**env, "cwd": cwd})
        return await super()._exec_argv(argv, stdin, env, cwd, output, errors)


@pytest.mark.asyncio
async def test_a_lookup_runs_in_the_environment_a_program_run_gets():
    dev = Exported("dev", asking(FakeFiles(), {"tool": ["/opt/tools/tool"]}))
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, machines={"dev": dev}
    )
    await ws.shell("export PATH=/opt/tools:$PATH TOOLS=on")
    assert await out(ws, "which tool") == "/usr/bin/tool\n"
    seen = dev.envs[0]
    assert seen["PATH"].startswith("/opt/tools:")
    assert (seen["TOOLS"], seen["cwd"]) == ("on", "/")
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_answer_that_prints_nothing_still_finds_the_name():
    def answer(line: str, data: bytes | None) -> RunAnswer:
        if _bash_line(line) == "type -p kill":
            return ok(b"")
        return FakeFiles().answer(line, data)

    dev = ScriptedMachine("dev", answer)
    dev.config = replace(dev.config, captures=("kill", "@external"))
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, machines={"dev": dev}
    )
    io = await ws.shell("type -p kill")
    assert (await io.stdout_str(), io.exit_code) == ("", 0)
    await ws.close()


@pytest.mark.asyncio
async def test_with_no_machine_to_run_a_name_no_machine_is_asked():
    ws, dev = await lookup_ws(
        {"perl": ["/usr/bin/perl"]}, captures=["@python"]
    )
    which = await ws.shell("which perl")
    assert (await which.stdout_str(), which.exit_code) == ("", 1)
    assert looked_up(dev) == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_path_shown_as_the_machine_s_own_is_kept_others_run_by_name():
    files = FakeFiles({"/tmp/bin/tool": b"\x7fELF"})
    ws, _ = await lookup_ws(
        {"tool": ["/tmp/bin/tool"], "ldconfig": ["/usr/sbin/ldconfig"]},
        files=files,
    )
    assert await out(ws, "which tool") == "/tmp/bin/tool\n"
    assert await out(ws, "which ldconfig") == "/usr/bin/ldconfig\n"
    assert await out(ws, "type ldconfig") == "ldconfig is /usr/bin/ldconfig\n"
    assert await out(ws, "$(which ldconfig) -p") == "ran\n"
    assert files.ran[-1] == "ldconfig -p"
    await ws.close()


class Reporting(ScriptedMachine):
    """A machine that reports a program it has no file for in the words
    the run hands its wrapper (``PROGRAM_CHECK``), with status 127."""

    def __init__(self, name: str, answer, programs: set[str]) -> None:
        super().__init__(name, answer)
        self.programs = programs

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if is_run(argv) and argv[RUN_PROGRAM_AT] not in self.programs:
            lead, reason = argv[5], argv[6]
            await errors(f"{lead}{reason}\n".encode())
            return RunResult(127)
        return await super()._exec_argv(argv, stdin, env, cwd, output, errors)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,said,status",
    [
        ("env nosuch", "env: 'nosuch': No such file or directory\n", 127),
        ("(exec nosuch)", "bash: line 1: exec: nosuch: not found\n", 127),
        (
            "xargs nosuch </dev/null",
            "xargs: nosuch: No such file or directory\n",
            127,
        ),
        (
            "timeout 5 nosuch",
            "timeout: failed to run command 'nosuch': No such file or directory\n",
            127,
        ),
    ],
)
async def test_a_program_the_machine_lacks_is_reported_in_its_runner_s_words(
    line, said, status
):
    dev = Reporting("dev", FakeFiles().answer, set())
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, machines={"dev": dev}
    )
    io = await ws.shell(line)
    assert (await io.stderr_str(), io.exit_code) == (said, status)
    await ws.close()


@pytest.mark.asyncio
async def test_xargs_counts_a_program_that_ran_and_exited_127_as_a_failure():
    dev = Reporting("dev", lambda line, data: failed(b"", 127), {"tool"})
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, machines={"dev": dev}
    )
    io = await ws.shell("echo x | xargs tool")
    assert io.exit_code == 123
    nested = await ws.shell("echo x | xargs xargs nosuch")
    assert (await nested.stderr_str(), nested.exit_code) == (
        "xargs: nosuch: No such file or directory\n",
        123,
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_machine_that_captures_which_answers_every_which():
    ws, dev = await lookup_ws(
        {"grep": ["/bin/grep"]}, captures=["which", "@external"]
    )
    assert await out(ws, "which grep") == "/bin/grep\n"
    assert "which grep" in dev.lines
    await ws.close()
