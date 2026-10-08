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

from mirage.shell.helpers import get_parts
from mirage.shell.parse import parse
from mirage.workspace.node.inner_lines import (
    InnerLine,
    Word,
    inner_lines,
    read_word,
)


def _words(*texts: str) -> list[Word]:
    return [Word(t, t) for t in texts]


def _argv(inner: InnerLine) -> list[str]:
    return [w.value for w in inner.argv]


@pytest.mark.parametrize(
    "head, args, expected",
    [
        # Text the runtime parses afresh.
        ("eval", ["rm", "/x", "&&", "ls"], [("line", "rm /x && ls", False)]),
        ("sh", ["-c", "rm /x"], [("line", "rm /x", False)]),
        ("bash", ["-xc", "rm /x", "a"], [("line", "rm /x", False)]),
        ("mapfile", ["-C", "rm /x", "arr"], [("line", "rm /x", True)]),
        # A command already split into words.
        ("command", ["-p", "rm", "/x"], [("argv", ["rm", "/x"], False)]),
        ("exec", ["-a", "name", "rm", "/x"], [("argv", ["rm", "/x"], False)]),
        (
            "env",
            ["-i", "-u", "HOME", "A=1", "rm", "/x"],
            [("argv", ["rm", "/x"], False)],
        ),
        (
            "timeout",
            ["-s", "KILL", "5", "rm", "/x"],
            [("argv", ["rm", "/x"], False)],
        ),
        ("nohup", ["rm", "/x"], [("argv", ["rm", "/x"], False)]),
        # bash runs the named builtin with the words as given, so
        # `builtin eval 'rm /x'` is eval's line, admitted in turn.
        ("builtin", ["eval", "rm /x"], [("argv", ["eval", "rm /x"], False)]),
        ("builtin", ["--", "echo", "hi"], [("argv", ["echo", "hi"], False)]),
        ("builtin", [], []),
        ("nice", ["-n", "5", "rm", "/x"], [("argv", ["rm", "/x"], False)]),
        ("time", ["-p", "rm", "/x"], [("argv", ["rm", "/x"], False)]),
        # Operands the runtime appends: stdin items, matched paths.
        ("xargs", ["-n", "1", "rm", "-f"], [("argv", ["rm", "-f"], True)]),
        ("xargs", [], [("argv", ["echo"], True)]),
        (
            "find",
            ["/r", "-exec", "rm", "{}", ";", "-ok", "cat", "{}", "+"],
            [("argv", ["rm", "{}"], True), ("argv", ["cat", "{}"], True)],
        ),
        # Lines the gate cannot read: a file, a program from stdin, an
        # option mirage refuses and a real bash takes.
        ("source", ["f.sh"], [("none", None, False)]),
        (".", ["f.sh"], [("none", None, False)]),
        ("sh", ["f.sh"], [("none", None, False)]),
        ("bash", [], [("none", None, False)]),
        ("bash", ["--restricted", "-c", "rm /x"], [("none", None, False)]),
        ("./run.sh", ["a"], [("none", None, False)]),
        # Nothing runs: a probe, a bare word, a usage error, an answer.
        ("command", ["-v", "rm"], []),
        ("eval", [], []),
        ("env", ["A=1"], []),
        ("timeout", ["5"], []),
        ("bash", ["--version", "-c", "rm /x"], []),
        ("cat", ["/x"], []),
    ],
)
def test_inner_lines_read_the_words_that_run_other_words(head, args, expected):
    got = []
    for inner in inner_lines(head, _words(*args)):
        if inner.line is not None:
            got.append(("line", inner.line, inner.open))
        elif inner.argv:
            got.append(("argv", _argv(inner), inner.open))
        else:
            got.append(("none", None, inner.open))
        assert inner.readable == (inner.line is not None or bool(inner.argv))
    assert got == expected


@pytest.mark.parametrize(
    "head, args, missing",
    [
        (
            "xargs",
            ["-n", "1", "rm", "-f"],
            "xargs: rm: No such file or directory\n",
        ),
        ("xargs", [], "xargs: echo: No such file or directory\n"),
        (
            "timeout",
            ["-s", "KILL", "5", "rm", "/x"],
            "timeout: failed to run command 'rm': No such file or directory\n",
        ),
        ("env", ["rm", "/x"], None),
        ("command", ["rm", "/x"], None),
        ("find", ["/r", "-exec", "rm", "{}", ";"], None),
        ("eval", ["rm", "/x"], None),
    ],
)
def test_a_builtin_that_looks_the_name_up_reports_a_miss_itself(
    head, args, missing
):
    # xargs and timeout look the name up before they run it, as GNU's
    # exec does, so a name the session cannot see is theirs to report;
    # the rest hand the words back to the shell, which reports it.
    (inner,) = inner_lines(head, _words(*args))
    assert inner.missing == missing


def test_inner_words_keep_what_the_gate_could_not_read():
    # A dynamic word rides into the inner command as itself, raw text
    # and no literal, so the inner admission still sees it as unread.
    dynamic = Word('"$cmd"', None)
    (inner,) = inner_lines(
        "timeout", [Word("5", "5"), dynamic, Word("x", "x")]
    )
    assert inner.argv[0] is dynamic
    (inner,) = inner_lines("eval", [Word("rm", "rm"), Word('"$p"', None)])
    assert inner.line == 'rm "$p"'


@pytest.mark.parametrize("head", ["bash", "sh"])
@pytest.mark.parametrize(
    "before, after",
    [
        (["--rcfile"], ["--version", "-c", "rm /x"]),
        (["--init-file"], ["--help", "-c", "rm /x"]),
        (["--rcfile"], ["-c", "echo safe", "-c", "rm /x"]),
        (["-c"], ["rm /x"]),
    ],
)
def test_shell_program_selection_stops_at_a_dynamic_word(head, before, after):
    args = [*_words(*before), Word("$SKIP", None), *_words(*after)]
    (inner,) = inner_lines(head, args)
    assert not inner.readable


@pytest.mark.parametrize("head", ["bash", "sh"])
def test_shell_literal_prefix_keeps_its_answer_and_program(head):
    dynamic = Word("$ARG", None)
    assert inner_lines(head, [*_words("--version"), dynamic]) == []
    (inner,) = inner_lines(head, [*_words("-c", "echo safe"), dynamic])
    assert inner.line == "echo safe"


@pytest.mark.parametrize(
    "raw, stable",
    [
        ("missing-*", False),
        ("missing-?", False),
        ("missing-[ab]", False),
        ("'missing-'*", False),
        (r"missing-\\*", False),
        ("@(x|y)", False),
        ("!(x)", False),
        ("{a,b}", False),
        ("'missing-*'", True),
        ('"missing-*"', True),
        (r"missing-\*", True),
        (r"missing-\[ab]", True),
        ('missing-"*"', True),
    ],
)
def test_shell_option_values_preserve_glob_quoting(raw, stable):
    tree = parse(f"bash --rcfile {raw} --version -c 'rm /x'")
    parts = get_parts(tree.named_children[0])
    inner = inner_lines("bash", [read_word(part) for part in parts[1:]])
    assert (inner == []) == stable
    if not stable:
        assert len(inner) == 1 and not inner[0].readable
