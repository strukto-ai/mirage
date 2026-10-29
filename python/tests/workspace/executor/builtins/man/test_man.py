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
from unittest.mock import MagicMock

from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import Command
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.version import __version__
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins.man import (
    ManPage,
    find_page,
    handle_man,
    render_page,
)
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var


def _mk_cmd(name, spec, filetype=None, vfs="ram"):
    return Command(
        name=name,
        spec=spec,
        vfs=vfs,
        filetype=filetype,
        fn=lambda *a, **kw: None,
    )


def _mk_mount(prefix, kind, cmds=None, general=None):
    mount = MagicMock()
    mount.prefix = prefix
    mount.vfs = MagicMock()
    mount.vfs.name = kind
    cmds = cmds or {}
    general = general or {}

    def _resolve(name, extension=None):
        if name in cmds:
            return cmds[name]
        if name in general:
            return general[name]
        return None

    def _all():
        seen = set()
        out = []
        for rc in cmds.values():
            if rc.name in seen:
                continue
            seen.add(rc.name)
            out.append(rc)
        for rc in general.values():
            if rc.name in seen:
                continue
            seen.add(rc.name)
            out.append(rc)
        return out

    mount.resolve_command = MagicMock(side_effect=_resolve)
    mount.all_commands = MagicMock(side_effect=_all)
    return mount


def _mk_registry(mounts):
    reg = MagicMock()
    reg.clis = CLIRegistry()
    reg.mounts = MagicMock(return_value=mounts)
    return reg


def _cli_tree() -> CLI:
    return CLI(
        spec=CommandSpec(
            name="linear",
            description="Linear API client",
            subcommands=(
                CommandSpec(
                    name="issue",
                    description="Manage issues",
                    aliases=("i",),
                    subcommands=(
                        CommandSpec(name="create", description="Create one"),
                    ),
                ),
                CommandSpec(name="team", description="Manage one"),
            ),
        ),
        handlers={
            "issue create": CLIHandler(fn=lambda: None),
            "team": CLIHandler(fn=lambda: None),
        },
    )


def _cli_registry(mounts=None):
    reg = _mk_registry(mounts or [])
    reg.clis.install("linear", _cli_tree())
    return reg


def _man(args, reg, **env):
    session = SessionState(session_id="s1")
    for name, value in env.items():
        seed_var(session, name, value)
    return asyncio.run(handle_man(args, reg, session))


def _header(title):
    centered = title.ljust(28) + "General Commands Manual"
    return centered.ljust(79 - len(title)) + title + "\n"


def _footer(title):
    return f"Mirage {__version__}".ljust(79 - len(title)) + title + "\n"


def test_a_page_has_the_man_layout():
    spec = CommandSpec(
        description="Join files.",
        arguments=(
            Argument(
                "-n", "--number", action="store_true", help="number lines"
            ),
            Argument("-s", action="store_true", help="squeeze blanks"),
        ),
    )
    cat = _mk_cmd("cat", spec)
    out, io, _node = _man(
        ["cat"], _mk_registry([_mk_mount("/a/", "ram", {"cat": cat})])
    )
    assert io.exit_code == 0
    assert out.decode() == (
        _header("CAT(1)")
        + "\nNAME\n       cat - Join files.\n\n"
        + "SYNOPSIS\n       cat [OPTION]... [FILE]...\n\n"
        + "DESCRIPTION\n       Join files.\n\n"
        + "OPTIONS\n       -n, --number\n              number lines\n\n"
        + "       -s     squeeze blanks\n\n"
        + _footer("CAT(1)")
    )


def test_an_operand_with_help_of_its_own_is_listed():
    spec = CommandSpec(
        arguments=(
            Argument("PATH", type="path", help="where to write"),
            Argument("rest", nargs="*"),
        ),
    )
    reg = _mk_registry(
        [_mk_mount("/a/", "ram", {"put": _mk_cmd("put", spec)})]
    )
    text = _man(["put"], reg)[0].decode()
    assert "OPERANDS\n       PATH   where to write\n\n" in text
    assert "rest" not in text.split("OPERANDS")[1]


def test_a_page_without_a_description_names_the_command_alone():
    page = render_page(ManPage("bc", "", (("SYNOPSIS", ("bc",)),)), 80)
    assert "\nNAME\n       bc\n\n" in page


def test_text_fills_the_line_and_breaks_after_a_hyphen():
    words = " ".join(["a"] * 33) + " read-only word"
    page = render_page(ManPage("x", "", (("DESCRIPTION", (words,)),)), 80)
    assert (
        "       " + " ".join(["a"] * 33) + " read-\n       only word\n" in page
    )


def test_the_width_follows_manwidth_then_columns():
    spec = CommandSpec(description="Join files.")
    reg = _mk_registry(
        [_mk_mount("/a/", "ram", {"cat": _mk_cmd("cat", spec)})]
    )
    narrow = _man(["cat"], reg, MANWIDTH="60", COLUMNS="100")[0].decode()
    assert len(narrow.split("\n")[0]) == 59
    wide = _man(["cat"], reg, COLUMNS="100")[0].decode()
    assert len(wide.split("\n")[0]) == 99


def test_the_first_registration_is_the_page_and_dev_is_skipped():
    dev = _mk_mount(
        "/dev/", "dev", {"cat": _mk_cmd("cat", CommandSpec(description="dev"))}
    )
    ram = _mk_mount(
        "/a/", "ram", {"cat": _mk_cmd("cat", CommandSpec(description="ram"))}
    )
    s3 = _mk_mount(
        "/b/", "s3", {"cat": _mk_cmd("cat", CommandSpec(description="s3"))}
    )
    assert find_page("cat", _mk_registry([dev, ram, s3])).summary == "ram"


def test_a_wrapper_has_the_page_of_the_program_it_runs():
    grep = _mk_cmd("grep", CommandSpec(description="Search."))
    reg = _mk_registry([_mk_mount("/a/", "ram", {"grep": grep})])
    page = find_page("egrep", reg)
    assert page.name == "egrep"
    assert page.sections == find_page("grep", reg).sections


def test_a_builtin_page_is_its_help_topic():
    text = _man(["wait"], _mk_registry([]))[0].decode()
    assert text.startswith(_header("WAIT(1)"))
    assert (
        "NAME\n       wait - Wait for jobs and return their status.\n" in text
    )
    assert "SYNOPSIS\n       wait [-fn] [-p var] [id ...]\n" in text
    assert "       -n     wait for the next job to end" in text
    assert "EXIT STATUS\n" in text


def test_bash_and_sh_have_the_bash_spec_page():
    bash = _man(["bash"], _mk_registry([]))[0].decode()
    assert bash.startswith(_header("BASH(1)"))
    sh = _man(["sh"], _mk_registry([]))[0].decode()
    assert sh.startswith("SH(1)")
    reg = _mk_registry([])
    assert (
        find_page("sh", reg).sections[1:]
        == find_page("bash", reg).sections[1:]
    )


def test_no_page_asks_which():
    out, io, _node = _man([], _mk_registry([]))
    assert out is None
    assert io.exit_code == 1
    assert (
        io.stderr
        == b"What manual page do you want?\nFor example, try 'man man'.\n"
    )


def test_a_missing_page_is_status_16_after_the_pages_found():
    out, io, _node = _man(["nope", "wait"], _mk_registry([]))
    assert out.decode().startswith("WAIT(1)")
    assert io.exit_code == 16
    assert io.stderr == b"No manual entry for nope\n"


def test_a_section_other_than_1_has_no_pages():
    out, io, _node = _man(["2", "wait"], _mk_registry([]))
    assert out is None
    assert io.exit_code == 16
    assert io.stderr == b"No manual entry for wait in section 2\n"
    assert _man(["1", "wait"], _mk_registry([]))[1].exit_code == 0


def test_an_option_after_a_page_is_a_page():
    _out, io, _node = _man(["wait", "-f"], _mk_registry([]))
    assert io.stderr == b"No manual entry for -f\n"


def test_whatis_prints_the_summary_lines():
    out, io, _node = _man(["-f", "wait", "nope", "cd"], _mk_registry([]))
    assert io.exit_code == 0
    assert out == (
        b"wait (1)             - Wait for jobs and return their status.\n"
        b"cd (1)               - Change the working directory.\n"
    )
    assert io.stderr == b"nope: nothing appropriate.\n"
    assert _man(["-f", "nope"], _mk_registry([]))[1].exit_code == 16


def test_apropos_searches_names_and_summaries_ignoring_case():
    out, io, _node = _man(["-k", "JOB"], _mk_registry([]))
    assert io.exit_code == 0
    lines = out.decode().splitlines()
    assert [line.split()[0] for line in lines] == [
        "disown",
        "fg",
        "jobs",
        "kill",
        "wait",
    ]
    assert _man(["-k", "zzzz"], _mk_registry([]))[1].exit_code == 16


def test_option_refusals_name_the_option_and_hint():
    hint = b"Try 'man --help' or 'man --usage' for more information.\n"
    for args, message in (
        (["-x"], b"man: invalid option -- 'x'\n"),
        (["--nope"], b"man: unrecognized option '--nope'\n"),
        (
            ["--a", "ls"],
            b"man: option '--a' is ambiguous; possibilities: '--all' '--apropos'\n",
        ),
        (
            ["--whatis=ls"],
            b"man: option '--whatis' doesn't allow an argument\n",
        ),
        (["-fk", "ls"], b"man: -f -k : incompatible options\n"),
    ):
        _out, io, _node = _man(args, _mk_registry([]))
        assert io.exit_code == 1
        assert io.stderr == message + hint
    assert _man(["-f"], _mk_registry([]))[1].stderr == b"whatis what?\n"
    assert _man(["-k"], _mk_registry([]))[1].stderr == b"apropos what?\n"


def test_help_and_usage_answer_on_stdout():
    out, io, _node = _man(["--help"], _mk_registry([]))
    assert io.exit_code == 0
    assert out.startswith(
        b"man: Show the manual page of a command.\n\n"
        b"Usage: man [OPTION...] [SECTION] PAGE...\n"
    )
    assert _man(["-?"], _mk_registry([]))[0] == out
    assert _man(["-h"], _mk_registry([]))[0] == out
    assert _man(["--usage"], _mk_registry([]))[0] == (
        b"Usage: man [OPTION...] [SECTION] PAGE...\n"
    )


def test_an_installed_cli_has_a_page_with_its_commands():
    text = _man(["linear"], _cli_registry())[0].decode()
    assert text.startswith(_header("LINEAR(1)"))
    assert "NAME\n       linear - Linear API client\n" in text
    assert (
        "COMMANDS\n       issue  Manage issues\n\n       team   Manage one\n"
        in text
    )


def test_a_subcommand_page_is_named_with_hyphens():
    reg = _cli_registry()
    text = _man(["linear", "issue", "create"], reg)[0].decode()
    assert text.startswith("LINEAR-ISSUE-CREATE(1)")
    assert "NAME\n       linear-issue-create - Create one\n" in text
    assert _man(["linear", "i", "create"], reg)[0].decode() == text
    assert _man(["linear-issue-create"], reg)[0].decode() == text
    assert _man(["linear-i-create"], reg)[0].decode() == text


def test_words_past_a_cli_path_are_pages_of_their_own():
    out, io, _node = _man(["linear", "bogus"], _cli_registry())
    assert out.decode().startswith("LINEAR(1)")
    assert io.exit_code == 16
    assert io.stderr == b"No manual entry for bogus\n"


def test_a_cli_comes_before_a_colliding_command_and_all_shows_both():
    spec = CommandSpec(description="mount side")
    mount = _mk_mount("/ram/", "ram", cmds={"linear": _mk_cmd("linear", spec)})
    reg = _cli_registry([mount])
    first = _man(["linear"], reg)[0].decode()
    assert "mount side" not in first
    both = _man(["-a", "linear"], reg)[0].decode()
    assert both.startswith(first)
    assert "mount side" in both[len(first) :]


def test_apropos_lists_cli_subcommand_pages():
    out = _man(["-k", "create one"], _cli_registry())[0]
    assert out == b"linear-issue-create (1) - Create one\n"
