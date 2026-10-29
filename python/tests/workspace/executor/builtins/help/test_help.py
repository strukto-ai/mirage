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

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.synopsis import SHELL_SYNOPSES
from mirage.version import __version__
from mirage.workspace.executor.builtins.help import TOPICS, fill, topic_help
from mirage.workspace.executor.builtins.help.constants import OPERAND_HELP
from mirage.workspace.lookup.constants import BASH_BUILTINS


def _run(*lines, **workspace):
    async def go():
        ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE, **workspace)
        try:
            out = []
            for line in lines:
                io = await ws.shell(line)
                out.append(
                    (
                        await io.stdout_str(),
                        await io.stderr_str(),
                        io.exit_code,
                    )
                )
            return out
        finally:
            await ws.close()

    return asyncio.run(go())


def test_fill_breaks_at_spaces_and_after_a_hyphen_inside_a_word():
    assert fill("aaa bbb ccc", 7) == ["aaa bbb", "ccc"]
    assert fill("aaaa read-only", 10) == ["aaaa read-", "only"]
    assert fill("aaaa --all", 8) == ["aaaa", "--all"]
    assert fill("averyveryverylongword x", 5) == ["averyveryverylongword", "x"]


def test_the_listing_heads_with_the_version_and_lays_out_two_columns():
    out, err, code = _run("help")[0]
    assert code == 0 and err == ""
    lines = out.split("\n")
    assert lines[0] == f"bash (Mirage) {__version__}"
    assert lines[1] == (
        "A composable, scriptable and durable virtual terminal for AI agents."
    )
    assert lines[5] == (
        "A star (*) next to a name means that this session may not run it."
    )
    rows = lines[7:-1]
    assert len(rows) == (len(TOPICS) + 1) // 2
    assert rows[0] == (
        " (( expression ))".ljust(40)
        + " kill [-s sigspec | -n signum | -sigs>"
    )
    assert max(len(row) for row in rows) == 78


def test_a_synopsis_too_long_for_its_column_is_cut_with_a_mark():
    rows = _run("help")[0][0].split("\n")[7:]
    left = next(r for r in rows if r.startswith(" declare "))
    assert left[:40] == " declare [-aAfFgiIlnrtux] [name[=value> "
    right = next(r for r in rows if " read [" in r)
    assert right.endswith(" read [-ers] [-a array] [-d delim] [->")


@pytest.mark.parametrize(
    ("columns", "width"), [("60", 30), ("100x", 50), ("7", 40), ("abc", 40)]
)
def test_columns_sets_the_width_as_a_leading_integer(columns, width):
    out = _run(f"COLUMNS='{columns}' help")[0][0]
    first = out.split("\n")[7]
    assert first.startswith(" (( expression ))".ljust(width) + " kill ")


def test_a_command_the_profile_refuses_is_starred():
    out = _run(
        "help",
        profiles={"p": {"commands": {"allow": ["help", "echo"]}}},
        profile="p",
    )[0][0]
    rows = out.split("\n")[7:]
    assert any(r.startswith(" echo [-neE]") for r in rows)
    assert any(r.startswith("*cd [-L") for r in rows)
    assert any(r.startswith(" for NAME") for r in rows)


def test_a_pattern_names_its_exact_topic_else_prefixes_and_globs():
    assert _run("help -d read")[0][0] == (
        "read - Read one line and split it into fields.\n"
    )
    out = _run("help -d e")[0][0].splitlines()
    assert [line.split(" - ")[0] for line in out] == [
        "echo",
        "eval",
        "exec",
        "exit",
        "export",
    ]
    assert _run("help -s '[['")[0][0] == "[[ ... ]]: [[ expression ]]\n"


def test_a_glob_first_pattern_titles_the_output():
    out = _run("help -d 'w*' cd")[0][0]
    assert out == (
        "Shell commands matching keywords `w*, cd'\n\n"
        "wait - Wait for jobs and return their status.\n"
        "while - Run commands for as long as a condition holds.\n"
        "cd - Change the working directory.\n"
    )


def test_d_wins_over_m_and_m_over_s():
    assert _run("help -sd wait")[0][0].startswith("wait - ")
    assert _run("help -sm wait")[0][0].startswith("NAME\n    wait - ")


def test_a_topic_shows_its_synopsis_then_indented_help():
    out = _run("help wait")[0][0]
    assert out == topic_help("wait")
    assert out.startswith(
        "wait: wait [-fn] [-p var] [id ...]\n"
        "    Wait for jobs and return their status.\n    \n"
    )
    assert "    Options:\n      -f\twait until each ID ends" in out
    assert max(len(line) for line in out.split("\n")) <= 80


def test_the_manual_layout_ends_with_the_implementation():
    out = _run("help -m wait")[0][0]
    assert out.startswith(
        "NAME\n    wait - Wait for jobs and return their status.\n\n"
        "SYNOPSIS\n    wait [-fn] [-p var] [id ...]\n\nDESCRIPTION\n"
    )
    assert out.endswith(
        f"SEE ALSO\n    bash(1)\n\nIMPLEMENTATION\n"
        f"    bash (Mirage) {__version__}\n\n"
    )


def test_no_match_is_status_1_naming_the_last_pattern():
    out, err, code = _run("help zz yy")[0]
    assert (out, code) == ("", 1)
    assert err == (
        "bash: help: no help topics match `yy'.  Try `help help' or "
        "`man -k yy' or `info yy'.\n"
    )
    assert _run("help -d wait zz")[0][2] == 0


def test_an_invalid_option_is_status_2_with_the_usage():
    assert _run("help -x")[0] == (
        "",
        "bash: help: -x: invalid option\nhelp: usage: help [-dms] [pattern ...]\n",
        2,
    )


def test_a_raw_byte_pattern_is_named_as_typed():
    async def go():
        ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
        try:
            return await ws.shell("help $'\\xff'")
        finally:
            await ws.close()

    io = asyncio.run(go())
    assert io.exit_code == 1
    assert io.stderr == (
        b"bash: help: no help topics match `\xff'.  Try `help help' or "
        b"`man -k \xff' or `info \xff'.\n"
    )


def test_help_is_the_shells_own_and_no_program():
    assert _run("which help; echo rc=$?", "type -a help") == [
        ("rc=1\n", "", 0),
        ("help is a shell builtin\n", "", 0),
    ]


BUILTIN_TOPICS = sorted(
    name
    for name in SHELL_SYNOPSES
    if name in BASH_BUILTINS and name not in OPERAND_HELP
)


def test_every_topic_is_described_by_a_spec():
    assert TOPICS == tuple(sorted(SHELL_SYNOPSES))
    assert all(name in SHELL_SPECS for name in TOPICS)
    assert all(SHELL_SPECS[name].description for name in TOPICS)


@pytest.mark.parametrize("name", BUILTIN_TOPICS)
def test_help_as_the_first_word_prints_the_builtins_help(name):
    out, err, code = _run(f"( {name} --help )")[0]
    assert (out, err, code) == (topic_help(name), "", 2)


@pytest.mark.parametrize(
    ("line", "expect"),
    [
        ("echo --help", ("--help\n", "", 0)),
        ("true --help", ("", "", 0)),
        ("false --help", ("", "", 1)),
        (": --help", ("", "", 0)),
        ("test --help", ("", "", 0)),
    ],
)
def test_a_builtin_without_options_reads_help_as_an_operand(line, expect):
    assert _run(line)[0] == expect


def test_help_past_the_first_word_is_an_operand():
    out, err, code = _run("wait 99 --help")[0]
    assert code != 2 and "Wait for jobs" not in out


@pytest.mark.parametrize(
    "name",
    sorted(
        n
        for n in BUILTIN_TOPICS
        if n
        not in ("break", "continue", "exit", "return", "shift", "fg", "eval")
        and n not in ("let", "local", "source", ".", "getopts", "help")
        and n != "kill"
    ),
)
def test_each_usage_error_ends_with_the_topic_synopsis(name):
    _out, err, _code = _run(f"( {name} -% )")[0]
    usage = f"{name}: usage: {SHELL_SYNOPSES[name]}"
    assert usage in err
