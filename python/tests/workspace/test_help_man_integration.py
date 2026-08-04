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

from mirage.commands.cli.types import CLISpec
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


def _ws():
    ram = RAMResource()
    ram._store.files["/hello.txt"] = b"hi\n"
    return Workspace(resources={"/ram/": (ram, MountMode.EXEC)}, )


def _multi_ws():
    ram = RAMResource()
    ram._store.files["/a.txt"] = b"a\n"
    other = RAMResource()
    other._store.files["/b.txt"] = b"b\n"
    ro = RAMResource()
    ro._store.files["/c.txt"] = b"c\n"
    return Workspace(
        resources={
            "/ram/": (ram, MountMode.EXEC),
            "/other/": (other, MountMode.EXEC),
            "/ro/": (ro, MountMode.READ),
        })


def _exec(ws, cmd):
    return _run(ws.execute(cmd))


def _out(io):
    return io.stdout.decode() if isinstance(io.stdout, bytes) else _run(
        _materialize(io.stdout))


def test_help_flag_renders_help_through_executor():
    ws = _ws()
    io = _exec(ws, "cat --help")
    assert io.exit_code == 0
    out = io.stdout.decode() if isinstance(io.stdout, bytes) else _run(
        _materialize(io.stdout))
    assert "Usage: cat" in out
    assert "--help" in out
    assert "--version" in out


def test_version_flag_prints_mirage_package_version():
    ws = _ws()
    io = _exec(ws, "tsort --version")
    assert io.exit_code == 0
    out = io.stdout.decode() if isinstance(io.stdout, bytes) else _run(
        _materialize(io.stdout))
    assert out.startswith("tsort (Mirage) ")
    assert out.endswith("\n")


def test_version_beats_the_read_only_mount_refusal():
    ws = _multi_ws()
    io = _exec(ws, "rm --version /ro/c.txt")
    assert io.exit_code == 0
    assert _out(io).startswith("rm (Mirage) ")


def test_help_beats_the_read_only_mount_refusal():
    ws = _multi_ws()
    io = _exec(ws, "rm --help /ro/c.txt")
    assert io.exit_code == 0
    assert "Usage: rm" in _out(io)


def test_version_beats_cross_mount_routing():
    ws = _multi_ws()
    io = _exec(ws, "cat --version /ram/a.txt /other/b.txt")
    assert io.exit_code == 0
    assert _out(io).startswith("cat (Mirage) ")


def test_version_does_not_run_a_write_command():
    ws = _multi_ws()
    io = _exec(ws, "rm --version /ram/a.txt")
    assert io.exit_code == 0
    assert _out(_exec(ws, "cat /ram/a.txt")) == "a\n"


def test_version_after_end_of_options_stays_an_operand():
    ws = _multi_ws()
    io = _exec(ws, "grep -- --version /ram/a.txt")
    assert io.exit_code == 1
    assert _out(io) == ""


def test_man_renders_help_for_known_command():
    ws = _ws()
    io = _exec(ws, "man cat")
    assert io.exit_code == 0
    out = io.stdout.decode() if isinstance(io.stdout, bytes) else _run(
        _materialize(io.stdout))
    assert "cat" in out


def test_man_no_args_lists_commands_grouped_by_resource():
    ws = _ws()
    io = _exec(ws, "man")
    assert io.exit_code == 0
    out = io.stdout.decode() if isinstance(io.stdout, bytes) else _run(
        _materialize(io.stdout))
    assert "RAM" in out
    assert "- cat" in out
    assert "- ls" in out
    assert "# general" in out


def test_man_unknown_command_exits_1():
    ws = _ws()
    io = _exec(ws, "man definitely-not-a-real-command")
    assert io.exit_code == 1
    err = io.stderr.decode() if isinstance(io.stderr, bytes) else _run(
        _materialize(io.stderr))
    assert "no entry for" in err


def _cli_ws():
    ws = _ws()
    ws.register_cli(
        "linear",
        CLISpec(name="linear",
                description="Linear API client",
                subcommands=(CLISpec(name="issue",
                                     description="Manage issues",
                                     fn=lambda: None), )))
    return ws


def test_installed_cli_is_discoverable_from_the_shell():
    ws = _cli_ws()
    assert _out(_exec(ws, "type linear")) == "linear is a mirage CLI\n"
    assert _out(_exec(ws, "type -t linear")) == "cli\n"
    assert _out(_exec(ws, "which linear")) == "linear\n"
    assert "Usage: linear" in _out(_exec(ws, "man linear"))
    assert "# clis" in _out(_exec(ws, "man"))


def test_which_reports_a_missing_name_through_the_status_only():
    io = _exec(_cli_ws(), "which nope-xyz")
    assert io.exit_code == 1
    assert not io.stdout
    assert not io.stderr


def test_a_shell_function_shadows_a_cli_and_type_a_shows_both():
    ws = _cli_ws()
    assert _out(_exec(ws, "linear() { echo shadowed; }; type -a linear")) == (
        "linear is a function\nlinear is a mirage CLI\n")


def test_workspace_file_prompt_mentions_help_and_man():
    ws = _ws()
    prompt = ws.file_prompt
    assert "--help" in prompt
    assert "man <cmd>" in prompt
    assert "`man`" in prompt


async def _materialize(source):
    if source is None:
        return ""
    if isinstance(source, bytes):
        return source.decode()
    chunks = []
    async for chunk in source:
        chunks.append(chunk)
    return b"".join(chunks).decode()
