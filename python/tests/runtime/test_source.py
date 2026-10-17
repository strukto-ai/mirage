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

from mirage.commands.config import Context
from mirage.commands.spec import CommandSpec
from mirage.runtime.source import (
    Argv0Rules,
    resolve_program,
    skip_first_line,
)
from mirage.runtime.types import Program, RunResult
from mirage.types import PathSpec
from mirage.workspace.files import Files

RULES = Argv0Rules(
    payload="-c", stdin_operand="-", bare_stdin="", names_file=True
)


async def fake_dispatch(op, path, *args, **kwargs):
    if path.virtual == "/script.py":
        return b"print('from-script')", None
    raise FileNotFoundError(path.virtual)


def spec(path: str) -> PathSpec:
    return PathSpec(
        virtual=path,
        directory="/",
        resolved=True,
        vfs_path=path,
        raw_path=path,
    )


def no_module(name: str, label: str) -> str | None:
    return None


async def resolve(
    paths: list[PathSpec],
    texts: list[str],
    rules: Argv0Rules = Argv0Rules(),
    **fields,
) -> Program | RunResult:
    ctx = Context(vfs=Files([], fake_dispatch, ledger=False), **fields)
    return await resolve_program(
        paths, texts, ctx, "python3", rules, no_module, "echo"
    )


@pytest.mark.asyncio
async def test_payload_wins_and_operands_become_argv():
    program = await resolve(
        [spec("/a.py")], ["x"], RULES, flags={"c": "print(1)"}
    )
    assert program == Program(code="print(1)", args=["/a.py", "x"], prog="-c")


@pytest.mark.asyncio
async def test_script_operand_reads_through_the_files():
    program = await resolve([spec("/script.py")], ["--flag"], RULES)
    assert isinstance(program, Program)
    assert program.code == "print('from-script')"
    assert program.args == ["--flag"]
    assert program.prog == "/script.py"
    assert program.script_path == spec("/script.py")


@pytest.mark.asyncio
async def test_missing_script_reports_no_such_file():
    result = await resolve([spec("/nope.js")], [])
    assert isinstance(result, RunResult)
    assert result.exit_code == 1
    assert result.stderr == b"python3: /nope.js: No such file\n"


@pytest.mark.asyncio
async def test_no_input_reports_error():
    result = await resolve([], [])
    assert isinstance(result, RunResult)
    assert result.exit_code == 1
    assert result.stderr == b"python3: no input\n"


@pytest.mark.asyncio
async def test_piped_input_is_the_program_with_no_operand():
    program = await resolve([], [], RULES, stdin=b"print(2)")
    assert program == Program(code="print(2)", prog="")


@pytest.mark.asyncio
async def test_the_stdin_operand_ends_options_and_passes_the_rest():
    program = await resolve([], ["-", "a", "b"], RULES, stdin=b"print(3)")
    assert program == Program(code="print(3)", args=["a", "b"], prog="-")


@pytest.mark.asyncio
async def test_a_payload_leaves_stdin_to_the_program():
    program = await resolve([], [], RULES, flags={"c": "x"}, stdin=b"in")
    assert isinstance(program, Program)
    assert program.code == "x"
    assert program.stdin == b"in"


@pytest.mark.asyncio
async def test_a_module_this_runtime_cannot_run_is_refused():
    result = await resolve([], [], flags={"m": "json.tool"})
    assert isinstance(result, RunResult)
    assert result.exit_code == 1
    assert result.stderr == (
        b"python3: -m is not supported by the 'echo' runtime\n"
    )


@pytest.mark.asyncio
async def test_a_module_names_itself_in_argv0():
    program = await resolve_program(
        [],
        ["a"],
        Context(flags={"m": "json.tool"}),
        "python3",
        RULES,
        lambda name, label: f"run {name} as {label}",
        "echo",
    )
    assert program == Program(
        code="run json.tool as python3", args=["a"], prog="json.tool"
    )


@pytest.mark.asyncio
async def test_a_script_cli_names_itself_after_its_head_word():
    program = await resolve(
        [],
        [],
        RULES,
        flags={"c": "pass", "script_cli": True},
        spec=CommandSpec(name="tool"),
    )
    assert isinstance(program, Program)
    assert program.prog == "tool"
    assert program.script_cli is True


def test_skip_first_line_empties_the_line_rather_than_dropping_it():
    # CPython keeps the file's numbering under -x, so a raise on
    # physical line 2 still reports line 2.
    assert skip_first_line("junk\nprint(1)\n") == "\nprint(1)\n"


@pytest.mark.asyncio
async def test_skip_line_applies_to_a_script_operand():
    program = await resolve([spec("/script.py")], [], flags={"x": True})
    assert isinstance(program, Program)
    # The fixture script is a single line, so -x leaves nothing of it.
    assert program.code == ""


@pytest.mark.asyncio
async def test_skip_line_leaves_a_payload_alone():
    # CPython's -x reads the script file; -c, -m and stdin are
    # untouched by it.
    program = await resolve([], [], flags={"c": "print(1)", "x": True})
    assert isinstance(program, Program)
    assert program.code == "print(1)"
