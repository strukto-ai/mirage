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

CASES = [
    ('X=hi; echo "${X:-fallback}"', "hi\n"),
    ('echo "${UNSET:-fallback}"', "fallback\n"),
    ('X=""; echo "${X:-fallback}"', "fallback\n"),
    ('X=""; echo "${X-fallback}"', "\n"),
    ('echo "${UNSET-fallback}"', "fallback\n"),
    ('X=hi; echo "${X:+yes}"', "yes\n"),
    ('echo "${UNSET:+yes}"', "\n"),
    ('X=""; echo "${X:+yes}"', "\n"),
    ('X=""; echo "${X+yes}"', "yes\n"),
    ('X=hello; echo "${#X}"', "5\n"),
    ('X=""; echo "${#X}"', "0\n"),
    ('X=hello; echo "${X:1:3}"', "ell\n"),
    ('X=hello; echo "${X:1}"', "ello\n"),
    ('X=hello; echo "${X: -3}"', "llo\n"),
    ('X=foobar; echo "${X#foo}"', "bar\n"),
    ('X=foobar; echo "${X%bar}"', "foo\n"),
    ('X=a/b/c/d; echo "${X##*/}"', "d\n"),
    ('X=a/b/c/d; echo "${X%%/*}"', "a\n"),
    ('X=a/b/c/d; echo "${X#*/}"', "b/c/d\n"),
    ('X=a/b/c/d; echo "${X%/*}"', "a/b/c\n"),
    ('X=foobarfoo; echo "${X/foo/baz}"', "bazbarfoo\n"),
    ('X=foobarfoo; echo "${X//foo/baz}"', "bazbarbaz\n"),
    ('X=foobar; echo "${X/foo/}"', "bar\n"),
    ('X=hello; echo "${X^^}"', "HELLO\n"),
    ('X=HELLO; echo "${X,,}"', "hello\n"),
    ('X=hello; echo "${X^}"', "Hello\n"),
    ('X=HELLO; echo "${X,}"', "hELLO\n"),
    ('X=hello; Y=X; echo "${!Y}"', "hello\n"),
    ('echo "${UNSET:=def}"; echo "$UNSET"', "def\ndef\n"),
    ('X=""; echo "${X:=def}"; echo "$X"', "def\ndef\n"),
    ('X=hi; echo "${X:=def}"; echo "$X"', "hi\nhi\n"),
    ('X=""; echo "start${X=def}end"; echo "[$X]"', "startend\n[]\n"),
    ('echo "${UNSET=def}"; echo "$UNSET"', "def\ndef\n"),
    ('X=""; echo "start${X?msg}end"', "startend\n"),
    ('X=hi; echo "${X:?msg}"', "hi\n"),
    ('X=banana; echo "${X/a*/Y}"', "bY\n"),
    ('X=hello; echo "${X/l?/Y}"', "heYo\n"),
    ('X=hello; echo "${X/#he/HE}"', "HEllo\n"),
    ('X=hello; echo "${X/#lo/Y}"', "hello\n"),
    ('X=hello; echo "${X/%lo/LO}"', "helLO\n"),
    ('X=hello; echo "${X/%he/Y}"', "hello\n"),
    ('X="a b c"; echo "${X// /_}"', "a_b_c\n"),
    ('X=hello; echo "${X^^[el]}"', "hELLo\n"),
    ('D=inner; echo "${UNSET_PN:-$D}"', "inner\n"),
    ('echo "${UNSET_PN2:-$(echo subbed)}"', "subbed\n"),
    ('EXT=.txt; F=a.txt; echo "${F%$EXT}"', "a\n"),
    ('PAT=l; X=hello; echo "${X//$PAT/L}"', "heLLo\n"),
    ('X=abcdef; echo "${X:1+1}"', "cdef\n"),
    ('X=abcdef; O=2; echo "${X:O:2}"', "cd\n"),
    ('X=abcdef; echo "${X:1:-2}"', "bcd\n"),
    ('X=hello; echo "${X#?}"', "ello\n"),
    ('X=hello; echo "${X%[lo]*}"', "hell\n"),
    ('X=abc; echo "${X#[!x]}"', "bc\n"),
    ('X=abc; echo "${X#[^x]}"', "bc\n"),
    ('f() { local T=inner; REF=T; echo "${!REF}"; }; f', "inner\n"),
]


@pytest.mark.parametrize("cmd,expected", CASES)
def test_param_expansion(shell, cmd, expected):
    assert shell.mirage(cmd) == expected


def test_error_op_unset_is_fatal_127(shell):
    code, out, err = shell.mirage_result("echo ${UNSET:?}; echo after")
    assert code == 127
    assert out == ""
    assert err == "bash: UNSET: parameter null or not set\n"


def test_error_op_custom_multiword_message(shell):
    code, _, err = shell.mirage_result("echo ${UNSET:?custom msg}")
    assert code == 127
    assert err == "bash: UNSET: custom msg\n"


def test_error_op_unset_only_default_message(shell):
    code, _, err = shell.mirage_result("echo ${UNSET?}")
    assert code == 127
    assert err == "bash: UNSET: parameter not set\n"


def test_error_op_contained_by_subshell(shell):
    code, out, _ = shell.mirage_result("(echo ${UNSET:?}); echo after code=$?")
    assert code == 0
    assert out == "after code=1\n"


def test_error_op_contained_by_pipeline(shell):
    code, out, _ = shell.mirage_result(
        "echo ${UNSET:?} | cat; echo after code=$?")
    assert code == 0
    assert out == "after code=0\n"


def test_assign_op_inside_function_local(shell):
    out = shell.mirage(
        'f(){ local v=; echo "${v:=zz}"; echo "inner=$v"; }; f; '
        'echo "outer=[$v]"')
    assert out == "zz\ninner=zz\nouter=[]\n"


def test_dollar_spelled_substring_offset_is_bad_substitution(shell):
    # tree-sitter-bash cannot parse a $-spelled offset (${v:$o}); mirage
    # fails loudly (exit 2) instead of emitting the mis-parse. bash
    # accepts it, so spell it ${v:o} or ${v:$((o))} (both supported).
    code, out, err = shell.mirage_result('v=hello; o=2; echo "X${v:$o}Y"')
    assert code == 2
    assert out == ""
    assert err == "bash: ${v}: bad substitution\n"


def test_dollar_spelled_substring_offset_with_length(shell):
    code, _, err = shell.mirage_result('v=hello; o=2; echo "${v:$o:2}"')
    assert code == 2
    assert "bad substitution" in err
