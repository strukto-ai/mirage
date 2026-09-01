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

from mirage.shell.parse import env_reads, implicit_reads, opaque_reads, parse


@pytest.mark.parametrize(
    ("command", "whole", "names", "excluded"),
    [
        # env renders on any invocation: bare it prints, with a command
        # it hands the snapshot to a child.
        ("env", True, set(), set()),
        # An override or removal excludes exactly its name from the
        # whole read: the child cannot observe the standing value.
        ("env FOO=1 mycmd", True, set(), {"FOO"}),
        ("env -u TOKEN mycmd", True, set(), {"TOKEN"}),
        ("env --unset=TOKEN mycmd", True, set(), {"TOKEN"}),
        ("env --unset TOKEN mycmd", True, set(), {"TOKEN"}),
        ("env -uTOKEN mycmd", True, set(), {"TOKEN"}),
        ("env -u A B=2 mycmd", True, set(), {"A", "B"}),
        # A literal ignore-environment form proves the start is empty,
        # so nothing existing is read.
        ("env -i", False, set(), set()),
        ("env -i mycmd", False, set(), set()),
        ("env --ignore-environment mycmd", False, set(), set()),
        ("env - mycmd", False, set(), set()),
        ("env -0i", False, set(), set()),
        ("env -iu X mycmd", False, set(), set()),
        # -u consumes a value, so `-ui` unsets a variable named i and
        # `-u -i` one named -i; both still read the whole environment.
        ("env -ui mycmd", True, set(), {"i"}),
        ("env -u -i mycmd", True, set(), {"-i"}),
        ("env -u X mycmd", True, set(), {"X"}),
        # The first operand ends the options, and -- ends them too.
        ("env X=1 -i mycmd", True, set(), {"X"}),
        ("env -- -i mycmd", True, set(), set()),
        # A word no static read can spell ends the claim: it may be the
        # command, demoting later words to arguments. What was consumed
        # before it keeps its effect; after a proven -i it changes
        # nothing.
        ("env $x mycmd", True, set(), set()),
        ("env -u A $x -u B mycmd", True, set(), {"A"}),
        ("env A=1 $x B=2 mycmd", True, set(), {"A"}),
        ("env -i $x", False, set(), set()),
        # An option the builtin refuses stops it from running at all,
        # so nothing is read.
        ("env --bogus mycmd", False, set(), set()),
        ("env --unset", False, set(), set()),
        # An assignment prefix overrides its name for the invocation's
        # environment, whoever renders it; += proves nothing.
        ("TOKEN=local env", True, set(), {"TOKEN"}),
        ("TOKEN=local set", True, set(), {"TOKEN"}),
        ("TOKEN=local printenv", True, set(), {"TOKEN"}),
        ("TOKEN=local printenv TOKEN", False, set(), set()),
        ("TOKEN=local printenv TOKEN OTHER", False, {"OTHER"}, set()),
        ("TOKEN+=x printenv TOKEN", False, {"TOKEN"}, set()),
        ("TOKEN=local env -u OTHER mycmd", True, set(), {"TOKEN", "OTHER"}),
        # Exclusions fold by intersection: a name is skippable only
        # when every whole read skips it.
        ("env -u A mycmd; env -u B mycmd", True, set(), set()),
        ("env -u A mycmd; env -u A other", True, set(), {"A"}),
        ("env -u A mycmd; export", True, set(), set()),
        ("set", True, set(), set()),
        ("set -u", False, set(), set()),
        ("set -- a b", False, set(), set()),
        ("printenv", True, set(), set()),
        ("printenv -0", True, set(), set()),
        ("printenv PATH TOKEN", False, {"PATH", "TOKEN"}, set()),
        # A print target only the runtime can spell selects everything.
        ("printenv $x", True, set(), set()),
        ("export", True, set(), set()),
        ("export -p", True, set(), set()),
        ("export -p TOKEN", False, {"TOKEN"}, set()),
        # Mutating forms read nothing: the write must not depend on a
        # source being alive.
        ("export TOKEN=local", False, set(), set()),
        ("export TOKEN", False, set(), set()),
        ("declare", True, set(), set()),
        ("declare -p A B", False, {"A", "B"}, set()),
        ("declare -x OTHER=1", False, set(), set()),
        # readonly and local print sets a managed entry can never be in.
        ("readonly", False, set(), set()),
        ("echo hi", False, set(), set()),
        # Inside a substitution counts; inside a definition does not.
        ("x=$(env)", True, set(), set()),
        ("f() { env; }", False, set(), set()),
    ])
def test_env_reads(command, whole, names, excluded):
    got = env_reads(parse(command))
    assert got == (whole, frozenset(names), frozenset(excluded))


@pytest.mark.parametrize(
    ("command", "opaque"),
    [
        ("echo ${!name}", True),
        ("echo ${!prefix@}", True),
        ("echo ${#name}", False),
        ("echo ${name:-d}", False),
        ("declare -n r=TOKEN", True),
        ("local -n r=TOKEN", True),
        ("typeset -n r=TOKEN", True),
        # -n means unexport / unset-the-ref there, not a nameref.
        ("export -n X", False),
        ("unset -n r", False),
        ("echo $T", False),
        # A definition's body is not read at definition time.
        ("f() { echo ${!name}; }", False),
    ])
def test_opaque_reads(command, opaque):
    assert opaque_reads(parse(command)) == opaque


@pytest.mark.parametrize(
    "command,names",
    [
        # A leading tilde reads $HOME wherever a word expands; ~user,
        # a mid-word tilde and a quoted one stay literal.
        ("echo ~", {"HOME"}),
        ("echo ~/logs", {"HOME"}),
        ("cat < ~/f", {"HOME"}),
        ('echo "~" b~ ~user', set()),
        # cd reads $HOME bare, $OLDPWD for -, $CDPATH for a searchable
        # relative operand, and everything for a dynamic word.
        ("cd", {"HOME"}),
        ("cd --", {"HOME"}),
        ("cd -", {"OLDPWD"}),
        ("cd -L sub", {"CDPATH"}),
        ("cd /a; cd ./b; cd ..", set()),
        ("cd ~", {"HOME"}),
        ("cd $d", {"HOME", "OLDPWD", "CDPATH"}),
        # read splits on $IFS; getopts resumes from $OPTIND and
        # consults $OPTERR before printing a diagnostic.
        ("read v", {"IFS"}),
        ("getopts ab o", {"OPTIND", "OPTERR"}),
        # A definition's body runs at invocation, not here.
        ("f() { cd; }", set()),
    ])
def test_implicit_reads(command, names):
    assert implicit_reads(parse(command)) == frozenset(names)
