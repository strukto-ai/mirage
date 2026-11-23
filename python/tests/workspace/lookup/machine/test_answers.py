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
from mirage.runtime.types import RunAnswer, RunResult
from tests.fixtures.machine import ScriptedMachine, failed, ok
from tests.fixtures.machine_files import FakeFiles, out


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
