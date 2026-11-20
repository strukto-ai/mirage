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

from mirage.commands.builtin.generic.fd import (
    batch_argv,
    exec_argv,
    parse_flags,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

SETUP = (
    "mkdir -p /w/r/.git /w/r/src/sub /w/r/docs /w/r/.hid /w/r/node_modules"
    " /w/r/emptyd && cd /w/r && touch src/a.ts src/B.ts src/sub/c.py"
    " docs/README.md .hid/x.ts .env node_modules/i.js AGENTS.md empty.txt"
    " && echo node_modules > .gitignore && echo hi > src/full.txt"
    " && printf 'B.ts\\n' > .fdignore && ln -s src/a.ts link.ts"
)


def _flags(flags: dict, texts: list[str] | None = None):
    return parse_flags(FlagView(flags, spec=SPECS["fd"]), texts or [])


def test_parse_flags_reads_types_case_and_depths():
    f = _flags({"type": ["e"], "ignore_case": True, "exact_depth": "2"})
    assert f.kinds.kinds == {"file", "directory"} and f.kinds.empty
    assert f.ignore_case and f.max_depth == f.min_depth == 2
    assert _flags({}, ["Foo"]).ignore_case is False
    assert _flags({}, ["[a-z]"]).ignore_case is True
    assert _flags({"glob": True}, ["*.MD"]).ignore_case is False
    executable = _flags({"type": ["x"]}).kinds
    assert executable.kinds == {"file"} and executable.executable


@pytest.mark.parametrize(
    "flags, message",
    [
        (
            {"type": ["q"]},
            "error: invalid value 'q' for '--type <filetype>'\n  [possible "
            "values: file, directory, symlink, block-device, char-device, "
            "executable, empty, socket, pipe]",
        ),
        (
            {"max_depth": "abc"},
            "error: invalid value 'abc' for '--max-depth <depth>': invalid "
            "digit found in string",
        ),
        (
            {"exec": []},
            "error: a value is required for '--exec <cmd>...' but none was "
            "supplied",
        ),
    ],
)
def test_parse_flags_refuses_in_clap_words(flags, message):
    with pytest.raises(UsageError) as caught:
        _flags(flags)
    assert (
        str(caught.value)
        == f"{message}\n\nFor more information, try '--help'."
    )
    assert caught.value.exit_code == 2


def test_exec_placeholders_fill_or_append():
    assert exec_argv(
        ["echo", "{/}", "{//}", "{.}", "{/.}"], "./src/sub/c.py"
    ) == [
        "echo",
        "c.py",
        "./src/sub",
        "src/sub/c",
        "c",
    ]
    assert exec_argv(["wc", "-l"], "a.ts") == ["wc", "-l", "a.ts"]
    assert batch_argv(["echo", "B"], ["a", "b"]) == ["echo", "B", "a", "b"]
    assert batch_argv(["echo", "<{}>", "end"], ["a", "b"]) == [
        "echo",
        "<a>",
        "<b>",
        "end",
    ]


async def _run(*lines: str) -> list[str]:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    out: list[str] = []
    try:
        for line in lines:
            io = await ws.shell(line)
            out.append(
                (io.stdout or b"").decode() + (io.stderr or b"").decode()
            )
    finally:
        await ws.close()
    return out


@pytest.mark.asyncio
async def test_fd_lists_sorted_entries_under_ignore_rules():
    out = await _run(
        SETUP,
        "cd /w/r && fd",
        "cd /w/r && fd -H -t f '^(AGENTS\\.md|\\.env)$'",
        "cd /w/r && fd -u i.js",
        "cd /w/r && fd -t d . src",
        "cd /w/r && fd -e ts -t l",
        "cd /w/r && fd -t e",
    )
    assert out[1] == (
        "AGENTS.md\ndocs/\ndocs/README.md\nempty.txt\nemptyd/\nlink.ts\n"
        "src/\nsrc/a.ts\nsrc/full.txt\nsrc/sub/\nsrc/sub/c.py\n"
    )
    assert out[2] == ".env\nAGENTS.md\n"
    assert out[3] == "node_modules/i.js\n"
    assert out[4] == "src/sub/\n"
    assert out[5] == "link.ts\n"
    assert out[6] == (
        "AGENTS.md\ndocs/README.md\nempty.txt\nemptyd/\nsrc/a.ts\n"
        "src/sub/c.py\n"
    )


@pytest.mark.asyncio
async def test_fd_runs_a_command_per_result_or_one_for_all():
    out = await _run(
        SETUP,
        "cd /w/r && fd '\\.py$' -x echo {/} {//}",
        "cd /w/r && fd -e ts . src -X echo B",
        "cd /w/r && fd -0 c.py | od -c | head -1",
    )
    assert out[1] == "c.py ./src/sub\n"
    assert out[2] == "B src/a.ts\n"
    assert (
        out[3]
        == "0000000   .   /   s   r   c   /   s   u   b   /   c   .   p   y  \\0\n"
    )


@pytest.mark.asyncio
async def test_fd_reports_search_paths_and_patterns_it_cannot_use():
    out = await _run(
        SETUP,
        "cd /w/r && fd c.py nosuch src; echo $?",
        "cd /w/r && fd c.py nosuch; echo $?",
        "cd /w/r && fd '['; echo $?",
        "cd /w/r && fd -q zzz; echo $?",
    )
    assert out[1] == (
        "src/sub/c.py\n0\n[fd error]: Search path 'nosuch' is not a directory.\n"
    )
    assert out[2] == (
        "1\n[fd error]: Search path 'nosuch' is not a directory.\n"
        "[fd error]: No valid search paths given.\n"
    )
    assert out[3].startswith(
        "1\n[fd error]: regex parse error:\n    [\n    ^\n"
        "error: unclosed character class\n\nNote: "
    )
    assert out[4] == "1\n"


CLAP_HINT = "\n\nFor more information, try '--help'.\n"


@pytest.mark.asyncio
async def test_fd_refuses_arguments_that_cannot_be_used_together():
    out = await _run(
        SETUP,
        "cd /w/r && fd -q -x echo {} a.ts",
        "cd /w/r && fd -1 -q -X echo \\;",
        "cd /w/r && fd a src --strip-cwd-prefix",
        "cd /w/r && fd -F -g x",
        "cd /w/r && fd -q --max-results 2 -1 zzz; echo $?",
    )
    assert out[1] == (
        "error: the argument '--quiet' cannot be used with:\n"
        "  --exec <cmd>...\n  --exec-batch <cmd>...\n  --list-details\n\n"
        f"Usage: fd --quiet [pattern] [path]...{CLAP_HINT}"
    )
    assert out[2] == (
        "error: the argument '-1' cannot be used with:\n"
        "  --exec-batch <cmd>...\n  --exec <cmd>...\n  --list-details\n\n"
        f"Usage: fd -1 --quiet [pattern] [path]...{CLAP_HINT}"
    )
    assert out[3] == (
        "error: the argument '[path]...' cannot be used with "
        "'--strip-cwd-prefix[=<when>]'\n\n"
        f"Usage: fd <pattern> <path>...{CLAP_HINT}"
    )
    assert out[4] == (
        "error: the argument '--fixed-strings' cannot be used with "
        f"'--glob'\n\nUsage: fd --fixed-strings <pattern> [path]...{CLAP_HINT}"
    )
    assert out[5] == "1\n"


@pytest.mark.asyncio
async def test_fd_lets_the_later_of_an_overriding_pair_win():
    out = await _run(
        SETUP,
        "cd /w/r && fd -g --regex ts src",
        "cd /w/r && fd --regex -g ts src",
        "cd /w/r && fd -1 --max-results 2 -t f . src",
        "cd /w/r && fd --max-results 2 -1 -t f . src",
    )
    assert out[1] == "src/a.ts\n"
    assert out[2] == ""
    assert out[3] == "src/a.ts\nsrc/full.txt\n"
    assert out[4] == "src/a.ts\n"


@pytest.mark.asyncio
async def test_fd_runs_every_repeated_command():
    out = await _run(
        SETUP,
        "cd /w/r && fd -t f -x echo first {} \\; -x echo second {} \\; c.py",
        "cd /w/r && fd -t f -X echo one \\; -X echo two \\; c.py",
    )
    assert out[1] == "first ./src/sub/c.py\nsecond ./src/sub/c.py\n"
    assert out[2] == "one ./src/sub/c.py\ntwo ./src/sub/c.py\n"


@pytest.mark.asyncio
async def test_fd_roots_excludes_at_its_first_search_path():
    out = await _run(
        "mkdir -p /w/d/data/cache /w/d/src && touch /w/d/data/cache/x"
        " /w/d/src/a",
        "cd /w/d && fd -E /cache . data",
        "cd /w/d && fd -E /cache . src data",
        "cd / && fd -E /cache . /w/d/data",
    )
    assert out[1] == ""
    assert out[2] == "data/cache/\ndata/cache/x\nsrc/a\n"
    assert out[3] == ""


@pytest.mark.asyncio
async def test_fd_keeps_the_first_results_in_its_order():
    out = await _run(
        SETUP,
        "cd /w/r && fd --max-results 2 -t f . src docs",
        "cd /w/r && fd -1 -t f",
    )
    assert out[1] == "src/a.ts\nsrc/full.txt\n"
    assert out[2] == "AGENTS.md\n"


@pytest.mark.asyncio
async def test_fd_stops_at_the_mounts_walk_limit():
    capped = RAMVFS()
    capped.walk_limit = 2
    ws = Workspace({"/": RAMVFS(), "/m": capped}, mode=MountMode.WRITE)
    try:
        await ws.shell("mkdir -p /m/d && touch /m/d/a /m/d/b /m/d/c")
        io = await ws.shell("fd . /m/d")
        assert io.exit_code == 1
        assert io.stdout == b"/m/d/a\n/m/d/b\n"
        assert io.stderr == (
            b"[fd error]: /m/d: stopped after 2 files (walk_limit); "
            b"narrow the path\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_fd_keeps_the_rules_around_a_bad_ignore_line():
    out = await _run(
        "mkdir -p /w/i && cd /w/i && touch a.log b.txt c.tmp"
        " && printf '[\\n*.log\\n' > .ignore && printf '[1\\n*.tmp\\n' > one"
        " && printf '[2\\n[3\\n' > two",
        "cd /w/i && fd -t f . --ignore-file one",
        "cd /w/i && fd -t f . --ignore-file two",
    )
    assert out[1] == (
        "b.txt\none\ntwo\n[fd error]: Malformed pattern in custom ignore "
        "file. one: line 1: error parsing glob '[1': unclosed character "
        "class; missing ']'.\n"
    )
    assert out[2] == "b.txt\nc.tmp\none\ntwo\n"


@pytest.mark.asyncio
async def test_fd_matches_ignore_rules_on_the_path_it_walked():
    out = await _run(
        "mkdir -p /w/L/repo /w/L/other && touch /w/L/other/a.log"
        " /w/L/other/b.txt && printf '*.log\\n' > /w/L/repo/.ignore"
        " && ln -s ../other /w/L/repo/link",
        "cd /w/L/repo && fd -L -t f",
    )
    assert out[1] == "link/b.txt\n"


@pytest.mark.asyncio
async def test_fd_refuses_what_it_reads_once_its_options_parse():
    out = await _run(
        SETUP,
        "cd /w/r && fd -j 0 x; echo $?",
        "cd /w/r && fd -X './{/.}' a.ts; echo $?",
        "cd /w/r && fd -X echo {} {/} a.ts; echo $?",
        "cd /w/r && fd -E '[z-a]' x; echo $?",
    )
    usage = "\n\nUsage: fd [OPTIONS] [pattern] [path]..."
    assert out[1] == (
        "2\nerror: invalid value '0' for '--threads <num>': number would be "
        f"zero for non-zero type{CLAP_HINT}"
    )
    assert out[2] == (
        "2\nerror: First argument of exec-batch is expected to be a fixed "
        f"executable{usage}{CLAP_HINT}"
    )
    assert out[3] == (
        "2\nerror: Only one placeholder allowed for batch commands"
        f"{usage}{CLAP_HINT}"
    )
    assert out[4] == (
        "1\n[fd error]: Malformed exclude pattern: error parsing glob "
        "'![z-a]': invalid range; 'z' > 'a'\n"
    )


@pytest.mark.asyncio
async def test_fd_reads_a_bare_strip_cwd_prefix_as_always():
    out = await _run(
        SETUP, "cd /w/r && fd -0 --strip-cwd-prefix c.py | od -c | head -1"
    )
    assert out[1] == (
        "0000000   s   r   c   /   s   u   b   /   c   .   p   y  \\0\n"
    )


@pytest.mark.asyncio
async def test_fd_charges_a_linked_mount_its_own_walk_limit():
    capped = RAMVFS()
    capped.walk_limit = 2
    ws = Workspace({"/": RAMVFS(), "/m": capped}, mode=MountMode.WRITE)
    try:
        await ws.shell(
            "mkdir -p /m/d /w && touch /m/d/a /m/d/b /m/d/c && ln -s /m/d /w/l"
        )
        io = await ws.shell("fd -L . /w")
        assert io.exit_code == 1
        assert io.stdout == b"/w/l/\n/w/l/a\n/w/l/b\n"
        assert io.stderr == (
            b"[fd error]: /m: stopped after 2 files (walk_limit); "
            b"narrow the path\n"
        )
    finally:
        await ws.close()
