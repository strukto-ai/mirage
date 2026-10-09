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

# Pinned against GNU bash 5.2.37 on debian:stable-slim.
NOEXEC = [
    ("set -n; echo hi", ""),
    ("echo a; set -n; echo b; echo c", "a\n"),
    # One-way within the same input: `set +n` is itself a statement, so
    # it never runs. GNU behaves the same way.
    ("set -n; set +n; echo after", ""),
    ("echo a; set -o noexec; echo b", "a\n"),
    # A subshell is its own shell, so `set -n` stops it and nothing
    # leaks back out. Integ caught this: the check lived only in the
    # program loop, and `handle_subshell` runs a second statement loop.
    ("(set -n; echo hi); echo rc=$?", "rc=0\n"),
    ("echo a; (set -n; echo b); echo c", "a\nc\n"),
    ("(set -n; set +n; echo after); echo rc=$?", "rc=0\n"),
    ("(set -n; echo x); echo still-here", "still-here\n"),
    ("echo a; echo b", "a\nb\n"),
]

VERBOSE = [
    # The unit is an input line, not a statement: the line that turned
    # the option on was already read, so nothing is echoed for it.
    ("set -v; echo hi", "hi\n", ""),
    ("set -v; echo a; set +v; echo b", "a\nb\n", ""),
    ("set -v\necho a\necho b", "a\nb\n", "echo a\necho b\n"),
    # `set +v` is echoed because the option is still on when its line
    # reaches the reader; the line after it is not.
    ("set -v\necho a\nset +v\necho b", "a\nb\n", "echo a\nset +v\n"),
    # A statement spanning several lines carries all of them.
    (
        "set -v\nfor i in 1 2; do\n echo $i\ndone",
        "1\n2\n",
        "for i in 1 2; do\n echo $i\ndone\n",
    ),
    # The reader consumes every line, not just the ones carrying a
    # statement, so comments and blank lines between commands are echoed
    # too. Clamping the range to the next executable row dropped them.
    ("set -v\n# note\n\necho ok", "ok\n", "# note\n\necho ok\n"),
    ("set -v\necho a\n\necho b", "a\nb\n", "echo a\n\necho b\n"),
    # A comment run before the first command is echoed with it.
    ("set -v\n# one\n# two\necho ok", "ok\n", "# one\n# two\necho ok\n"),
]


@pytest.mark.parametrize("cmd,out", NOEXEC)
def test_noexec(shell, cmd, out):
    assert shell.mirage(cmd) == out


@pytest.mark.parametrize("cmd,out,err", VERBOSE)
def test_verbose(shell, cmd, out, err):
    _, got_out, got_err = shell.mirage_result(cmd)
    assert got_out == out
    assert got_err == err


def test_option_listing_matches_gnu_defaults(shell):
    text = shell.mirage("set -o")
    # The three GNU turns on for a non-interactive shell, and nothing else.
    on = [ln.split()[0] for ln in text.splitlines() if ln.endswith("on")]
    assert on == ["braceexpand", "hashall", "interactive-comments"]
    assert text.startswith("allexport      \toff\n")
    assert "interactive-comments\ton\n" in text


def test_plus_o_listing_is_re_readable(shell):
    text = shell.mirage("set +o")
    assert text.startswith("set +o allexport\nset -o braceexpand\n")
    assert "set +o xtrace\n" in text


def test_brace_expansion_follows_its_option(shell):
    assert shell.mirage("echo {a,b}") == "a b\n"
    assert shell.mirage("set +B; echo {a,b}") == "{a,b}\n"
    assert "braceexpand    \toff\n" in shell.mirage("set +B; set -o")


# `set -n` stops everything after it at every depth, not only at the top
# of the input. GNU answers each of these with nothing at all: the option
# is read by the reader, so the statements after it are never executed
# wherever they sit. Pinned on bash 5.2.37, debian:stable-slim.
NESTED_NOEXEC = [
    "if true; then set -n; echo BAD; fi; echo rc=1",
    "f(){ set -n; echo BAD; }; f; echo rc=2",
    "for i in 1 2; do set -n; echo BAD; done; echo rc=3",
    "{ set -n; echo BAD; }; echo rc=4",
    "while true; do set -n; echo BAD; break; done; echo rc=5",
    "case x in x) set -n; echo BAD;; esac; echo rc=6",
]


@pytest.mark.parametrize("cmd", NESTED_NOEXEC)
def test_noexec_stops_a_nested_statement_runner(shell, cmd):
    # The check lived in the program loop alone, so `set -n` worked flat
    # and silently did nothing one construct deep: every one of these
    # printed BAD. It is stated in `execute_node` now, the one entry point
    # every node goes through.
    _, out, err = shell.mirage_result(cmd)
    assert out == ""
    assert err == ""
