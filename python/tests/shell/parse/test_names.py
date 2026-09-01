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

from mirage.shell.parse import (arith_reads, assignment_values,
                                command_invocations, command_words,
                                identifier_names, parse, referenced_names)


@pytest.mark.parametrize(
    ("command", "names"),
    [
        ("echo $X", {"X"}),
        ("echo ${X:-d}", {"X"}),
        ('echo "$X"', {"X"}),
        # Single quotes tokenize as raw_string with no children, so the
        # name inside is never a reference.
        ("echo '$X'", set()),
        ("echo $((X+1))", {"X"}),
        # The assignment's own name is a write, not a read; the
        # substitution body is walked.
        ("x=$(echo $Y)", {"Y"}),
        # An append starts from the value it extends, so its target is
        # a read where a plain assignment's is not.
        ("TOKEN+=x", {"TOKEN"}),
        ("export V+=$W", {"V", "W"}),
        ("cat <$F", {"F"}),
        # The loop variable is a write; the word list is a read.
        ("for i in $L; do echo hi; done", {"L"}),
        # Over-approximation on purpose: the walk is textual over the
        # whole tree, so a name an eval would read is fetched too.
        ('x=$(eval "$Z")', {"Z"}),
        ("echo ${a[i]}", {"a"}),
        ("(( X=Y+1 ))", {"X", "Y"}),
        ("export V=$W", {"W"}),
        # Bare names under a declaring builtin declare or delete.
        ("readonly R", set()),
        ("unset X", set()),
        ("TOKEN=1 printenv", set()),
        ("cat <<EOF\nhello $H\nEOF", {"H"}),
        ("echo hi", set()),
        # A definition's body runs at invocation, not here; the fill
        # layer joins invoked bodies back in through line_nodes.
        ('f() { echo "$T"; }', set()),
        ('f() { echo "$T"; }; echo $U', {"U"}),
    ])
def test_referenced_names(command, names):
    assert referenced_names(parse(command)) == frozenset(names)


@pytest.mark.parametrize(
    ("command", "words"),
    [
        ("echo hi", {"echo"}),
        ("env | grep A", {"env", "grep"}),
        ("x=$(printenv)", {"printenv"}),
        ("if env; then ls; fi", {"env", "ls"}),
        # The declaring builtins parse as their own node types; their
        # head word is still a command word.
        ("export X=1", {"export"}),
        ("declare -p", {"declare"}),
        ("unset X", {"unset"}),
        ("set", {"set"}),
        ("x=1", set()),
        # A definition's body runs at invocation; only the call is a
        # command word here.
        ("f() { python3 x.py; }; f", {"f"}),
    ])
def test_command_words(command, words):
    assert command_words(parse(command)) == frozenset(words)


@pytest.mark.parametrize(
    ("command", "invocations"),
    [
        ("ntn api get PAGE", (("ntn", ("api", "get", "PAGE")), )),
        # A dynamic word arrives as None, distinguishable from absent.
        ("slack msg send --to $u", (("slack",
                                     ("msg", "send", "--to", None)), )),
        # A dynamic head is None too: the program itself is
        # undecidable before expansion.
        ("$tool api get", ((None, ("api", "get")), )),
        ('"$t"x run', ((None, ("run", )), )),
        ("A=1 mycli run", (("mycli", ("run", )), )),
        ("mycli 'lit arg' \"plain\"", (("mycli", ("lit arg", "plain")), )),
        ("mycli run > out.txt", (("mycli", ("run", )), )),
        ("export X=1", ()),
        ("f() { inner verb; }", ()),
    ])
def test_command_invocations(command, invocations):
    assert command_invocations(parse(command)) == invocations


@pytest.mark.parametrize(
    ("text", "names"),
    [
        ("TOKEN + 1", {"TOKEN"}),
        ("a*b - c", {"a", "b", "c"}),
        ("42", set()),
        # Over-approximation on purpose: the hex literal sheds a token
        # that names nothing real.
        ("0x1f", {"x1f"}),
        ("", set()),
    ])
def test_identifier_names(text, names):
    assert identifier_names(text) == frozenset(names)


@pytest.mark.parametrize(
    ("command", "names"),
    [
        # The expansion forms, with variable_name and bare-word spellings.
        ("echo $((name))", {"name"}),
        ("echo $((a + b*2))", {"a", "b"}),
        ("echo $[x+1]", {"x"}),
        # The ((...)) command and a c-style for's header.
        ("((x = y + 1))", {"x", "y"}),
        ("for ((i=0; i<n; i++)); do echo hi; done", {"i", "n"}),
        # A subscript's index and a substring's offset are arithmetic;
        # the default-value form is not.
        ("echo ${a[i+1]}", {"a", "i"}),
        ("echo ${v:1+off}", {"off"}),
        ("echo ${v:-$d}", set()),
        # The [[ numeric comparators resolve bare words as variables;
        # string comparison and test/[ never do.
        ("[[ $x -lt lim ]]", {"x", "lim"}),
        ("[[ x == y ]]", set()),
        ("test x -lt 5", set()),
        # let evaluates each operand as an expression.
        ('let "y = x + 1" z+=2', {"y", "x", "z"}),
        # A plain expansion is not an arithmetic read.
        ("echo $name", set()),
        # A definition's body runs at invocation, not here.
        ("f() { echo $((q)); }", set()),
    ])
def test_arith_reads(command, names):
    assert arith_reads(parse(command)) == frozenset(names)


@pytest.mark.parametrize(
    ("command", "values"),
    [
        ("n=TOKEN; echo $((n))", (("n", "TOKEN", frozenset()), )),
        ("n='lit'", (("n", "lit", frozenset()), )),
        # A dynamic value reports its reads instead of a literal.
        ("n=$other", (("n", None, frozenset({"other"})), )),
        ("n=", (("n", "", frozenset()), )),
        # += reports its reads with the target among them: the append
        # starts from the standing value.
        ("n+=$q", (("n", None, frozenset({"n", "q"})), )),
        # An element write never replaces the whole value.
        ("a[0]=x", ()),
        # A prefix assignment is one too.
        ("N=v printenv", (("N", "v", frozenset()), )),
    ])
def test_assignment_values(command, values):
    assert assignment_values(parse(command)) == values
