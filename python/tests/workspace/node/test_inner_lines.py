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

from mirage.workspace.node.inner_lines import InnerLine, Word, inner_lines


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
        ("env", ["-i", "-u", "HOME", "A=1", "rm", "/x"
                 ], [("argv", ["rm", "/x"], False)]),
        ("timeout", ["-s", "KILL", "5", "rm", "/x"], [("argv", ["rm", "/x"
                                                                ], False)]),
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
        ("find", ["/r", "-exec", "rm", "{}", ";", "-ok", "cat", "{}", "+"
                  ], [("argv", ["rm", "{}"], True),
                      ("argv", ["cat", "{}"], True)]),
        # Lines the gate cannot read: a file, a program from stdin.
        ("source", ["f.sh"], [("none", None, False)]),
        (".", ["f.sh"], [("none", None, False)]),
        ("sh", ["f.sh"], [("none", None, False)]),
        ("bash", [], [("none", None, False)]),
        ("./run.sh", ["a"], [("none", None, False)]),
        # Nothing runs: a probe, a bare word, a usage error.
        ("command", ["-v", "rm"], []),
        ("eval", [], []),
        ("env", ["A=1"], []),
        ("timeout", ["5"], []),
        ("bash", ["--bogus"], []),
        ("cat", ["/x"], []),
    ])
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


def test_inner_words_keep_what_the_gate_could_not_read():
    # A dynamic word rides into the inner command as itself, raw text
    # and no literal, so the inner admission still sees it as unread.
    dynamic = Word('"$cmd"', None)
    (inner, ) = inner_lines(
        "timeout",
        [Word("5", "5"), dynamic, Word("x", "x")])
    assert inner.argv[0] is dynamic
    (inner, ) = inner_lines("eval", [Word("rm", "rm"), Word('"$p"', None)])
    assert inner.line == 'rm "$p"'
