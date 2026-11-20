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
