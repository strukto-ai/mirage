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

from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandSpec, Option
from mirage.io.types import DeviceInput
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command import routing
from mirage.workspace.executor.command.routing import (
    default_cwd_operand,
    merge_scopes,
    path_flag_scopes,
    program_tokens,
    routable_scopes,
)


def _path(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path="", resolved=True
    )


@pytest.mark.parametrize(
    "argv, expected",
    [
        (["--version", ".", "/a", "/b"], True),
        ([".", "/a", "/b", "-V"], True),
        (["--help", ".", "/a", "/b"], True),
        (["--bogus", ".", "/a", "/b"], True),
        ([".", "--", "--version", "/a", "/b"], False),
        (["--arg", "x", "--version", ".", "/a", "/b"], False),
        ([".", "/a", "/b"], False),
    ],
)
def test_option_loop_exits_only_for_a_parsed_early_answer(argv, expected):
    assert routing.option_loop_exits("jq", SPECS["jq"], argv, "/") is expected


def test_option_loop_exit_rules_do_not_apply_to_custom_grammars():
    spec = CommandSpec(options=(Option(long="--version"),))
    assert not routing.option_loop_exits("jq", spec, ["--version"], "/")
    assert not routing.option_loop_exits("jq", None, ["--version"], "/")


def test_merge_scopes_keeps_operand_order_and_dedupes():
    a, b = _path("/m/a"), _path("/m/b")
    dup = _path("/m/a")
    merged = merge_scopes([a, b], [dup, _path("/m/c")])
    assert [p.virtual for p in merged] == ["/m/a", "/m/b", "/m/c"]


def test_routable_scopes_drop_awk_assignment_operands():
    a, assign, b = _path("/m/a"), _path("/x=1"), _path("/m/b")
    assign = PathSpec(
        virtual="/x=1",
        directory="/",
        vfs_path="",
        resolved=True,
        raw_path="x=1",
    )
    routed = routable_scopes("awk", [a, assign, b])
    assert [p.virtual for p in routed] == ["/m/a", "/m/b"]
    assert routable_scopes("cat", [a, assign, b]) == [a, assign, b]


def test_routable_scopes_keep_a_dash_that_names_an_output():
    src = _path("/m/in")
    dash = PathSpec(
        virtual="/m/-",
        directory="/m",
        vfs_path="",
        resolved=True,
        raw_path="-",
    )
    assert routable_scopes("split", [src, dash]) == [src, dash]
    assert routable_scopes("split", [dash, src]) == [src]
    assert routable_scopes("cat", [src, dash]) == [src]


@pytest.mark.asyncio
async def test_awk_assignment_operand_keeps_the_line_on_one_mount():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("printf '1\\n' > /data/a; printf '2\\n' > /data/b")
        result = await ws.shell("awk '{print x, $0}' /data/a x=5 /data/b")
        assert (result.exit_code, result.stdout) == (0, b" 1\n5 2\n")
    finally:
        await ws.close()


def test_path_flag_scopes_reads_path_valued_flags():
    scopes = path_flag_scopes("shuf", ["--output=/dst/out", "/src/in"], "/")
    assert [s.virtual for s in scopes] == ["/dst/out"]


def test_path_flag_scopes_unknown_command_is_empty():
    assert path_flag_scopes("nosuchcmd", ["-x", "/a"], "/") == []


@pytest.mark.parametrize(
    "cmd, flag",
    [
        ("grep", "-f"),
        ("rg", "-f"),
        ("zgrep", "-f"),
        ("sed", "-f"),
        ("awk", "-f"),
        ("jq", "--from-file"),
    ],
)
def test_path_flag_scopes_leaves_a_program_file_out(cmd: str, flag: str):
    # The program file is read before routing, so a pattern file on
    # another mount does not make the line cross-mount, for every command
    # that reads one: the keys come from the reader's own table.
    assert path_flag_scopes(cmd, [flag, "/other/p", "/data/in"], "/") == []


@pytest.mark.parametrize(
    "cmd, argv",
    [
        ("curl", ["-o", "/other/body", "-D", "/data/h", "http://x.test/"]),
        (
            "curl",
            [
                "--dump-header",
                "-",
                "--output",
                "/other/body",
                "http://x.test/",
            ],
        ),
        (
            "jq",
            [
                "--slurpfile",
                "s",
                "/other/s.json",
                "--rawfile",
                "r",
                "/dev/fd/63",
                ".",
            ],
        ),
    ],
)
def test_path_flag_scopes_leaves_door_files_out(cmd: str, argv: list[str]):
    # The handler reaches them through the dispatcher, so they name no
    # mount the line has to run on (DOOR_FLAG_KEYS).
    assert path_flag_scopes(cmd, argv, "/") == []


def test_program_tokens_walks_a_cli_verb_path_and_keeps_the_rest_raw():
    ws = Workspace(mounts={"/ram": (RAMVFS(), MountMode.WRITE)})
    try:
        ws.register_cli("git", cli_spec_for("git"))
        reg = ws._registry
        # Options before the verb are not the verb; an alias reads as
        # its canonical name; the leaf's own words follow untouched.
        assert program_tokens(
            reg, "git", ["-C", "/r", "reset", "--hard", "HEAD"], "/"
        ) == (("git", "reset", "--hard", "HEAD"), ("git", "reset"))
        assert program_tokens(reg, "git", ["log", "-1"], "/") == (
            ("git", "log", "-1"),
            ("git", "log"),
        )
        # A walk the tree refuses (unknown verb, bare head) reads raw.
        assert program_tokens(reg, "git", ["frobnicate", "x"], "/") == (
            ("git", "frobnicate", "x"),
            ("git",),
        )
        assert program_tokens(reg, "git", [], "/") == (("git",), ("git",))
        # Anything else is the name and the raw argv.
        assert program_tokens(reg, "rm", ["-rf", "/x"], "/") == (
            ("rm", "-rf", "/x"),
            ("rm",),
        )
    finally:
        import asyncio

        asyncio.run(ws.close())


@pytest.mark.asyncio
async def test_rg_searches_the_cwd_once_dash_f_takes_stdin():
    # ripgrep 14.1.1: an attached stdin wins over the cwd, but `-f -`
    # reads it for patterns first, which leaves only the cwd to search.
    # The `-` arrives classified, so its spelling is what says stdin.
    ws = Workspace(mounts={"/ram": (RAMVFS(), MountMode.WRITE)})
    try:
        reg = ws._registry
        dash = PathSpec(
            virtual="/ram/-",
            directory="/ram/",
            vfs_path="",
            resolved=True,
            raw_path="-",
        )
        operand = default_cwd_operand(
            ["rg", "-f", dash], "rg", reg, "/ram", b"a\n"
        )
        assert operand is not None and operand.raw_path == ""
        assert (
            default_cwd_operand(
                ["rg", "-f", _path("/ram/p")], "rg", reg, "/ram", b"a\n"
            )
            is None
        )
        assert (
            default_cwd_operand(["rg", "a"], "rg", reg, "/ram", b"a\n") is None
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_rg_searches_the_cwd_when_stdin_is_a_device():
    # ripgrep 14.1.1 searches stdin only when a file, FIFO or socket is
    # attached (grep_cli::is_readable_stdin): `rg a < /dev/null` searches
    # the cwd, while an empty file or pipe is still searched.
    ws = Workspace(mounts={"/ram": (RAMVFS(), MountMode.WRITE)})
    try:
        reg = ws._registry
        operand = default_cwd_operand(
            ["rg", "a"], "rg", reg, "/ram", DeviceInput()
        )
        assert operand is not None and operand.raw_path == ""
        assert default_cwd_operand(["rg", "a"], "rg", reg, "/ram", b"") is None
    finally:
        await ws.close()
