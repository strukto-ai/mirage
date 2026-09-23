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

from mirage.shell.variable import VarAttr
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import env_snapshot

# Every case pinned against GNU bash 5.2.37 on debian:stable-slim.
# The environment is the *exported* set, not every string-valued
# variable, which is the whole subject of this file.
ENV_CASES = [
    # A plain assignment is a shell variable and never reaches `env`.
    ('X=hello; export Y=world; env | grep -E "^(X|Y)="', "Y=world\n"),
    # A name marked but never assigned is not in the environment either:
    # `export Z` declares, it does not give Z a value.
    ('export Z; env | grep -c "^Z="', "0\n"),
    # `export -n` keeps the value and drops the name from the env.
    ('export Y=world; export -n Y; env | grep -c "^Y="', "0\n"),
    # `set -a` marks what is assigned *while it is on*, and nothing else.
    ("B=1; set -a; C=2; set +a; D=3;"
     ' env | grep -cE "^(B|C|D)="', "1\n"),
    ("set -a; A=auto; env | grep '^A='", "A=auto\n"),
]

DECLARE_CASES = [
    # `--` for a plain scalar, `-x` once exported.
    ("X=hello; export Y=world; declare -p X Y",
     'declare -- X="hello"\ndeclare -x Y="world"\n'),
    # The declared-but-unset third state prints bare, with no `=`.
    ("export Z; declare -p Z", "declare -x Z\n"),
    # `declare -x` on an existing name keeps the value and adds the mark.
    ("E=val; declare -x E; declare -p E", 'declare -x E="val"\n'),
    # `export -n` is the off direction and leaves an ordinary variable.
    ("export Y=world; export -n Y; declare -p Y", 'declare -- Y="world"\n'),
    # Never exported, so `-n` is a no-op rather than an error.
    ("P=plain; export -n P; echo rc=$?; declare -p P",
     'rc=0\ndeclare -- P="plain"\n'),
    # Two attributes print in bash's own order (`r` before `x`), which
    # is `attr_letters`' order and not the order they were set in.
    ("export RO=v; readonly RO; declare -p RO", 'declare -rx RO="v"\n'),
    # `set -a` again, read through declare rather than env.
    ("B=1; set -a; C=2; set +a; D=3; declare -p B C D",
     'declare -- B="1"\ndeclare -x C="2"\ndeclare -- D="3"\n'),
]

EXPORT_P_CASES = [
    # Only exported names, and the unset one prints without a value.
    # Grepped to the three names under test because a real shell (and a
    # mirage session, which exports PWD) carries plenty of others.
    ("X=hello; export Y=world; export Z;"
     ' export -p | grep -E "^declare -x (X|Y|Z)"',
     'declare -x Y="world"\ndeclare -x Z\n'),
    # `export -n` removes it from the listing entirely.
    ('export Q; export -n Q; export -p | grep -c "declare -x Q"', "0\n"),
]


@pytest.mark.parametrize("cmd,out", ENV_CASES)
def test_env_carries_only_exported_names(shell, cmd, out):
    assert shell.mirage(cmd) == out


@pytest.mark.parametrize("cmd,out", DECLARE_CASES)
def test_declare_p_renders_the_attributes(shell, cmd, out):
    assert shell.mirage(cmd) == out


@pytest.mark.parametrize("cmd,out", EXPORT_P_CASES)
def test_export_p_lists_the_exported_set(shell, cmd, out):
    assert shell.mirage(cmd) == out


def test_printenv_is_a_process_view(shell):
    # printenv is a separate binary in GNU, so the only names it can
    # possibly see are exported ones; a plain variable exits 1.
    assert shell.mirage_result("X=plain; printenv X") == (1, "", "")
    assert shell.mirage("export X=e; printenv X") == "e\n"


def test_declare_p_reports_an_unknown_name(shell):
    # GNU prints the names it knows, refuses only the ones it does not,
    # and exits 1. Deliberate divergence: mirage's diagnostic carries no
    # `line N:` (GNU says `bash: line 1: declare: NOPE: not found`),
    # matching how every other mirage builtin words its errors.
    rc, out, err = shell.mirage_result("G=good; declare -p G NOPE")
    assert rc == 1
    assert out == 'declare -- G="good"\n'
    assert err == "bash: declare: NOPE: not found\n"


def test_pwd_is_exported_from_startup(shell):
    # bash exports $PWD, so a session that has never run `cd` still
    # hands one to a child.
    assert "PWD=" in shell.mirage("env")


def test_cd_exports_pwd_and_oldpwd(shell):
    # GNU prints `declare -x OLDPWD` too, and carries both into a child.
    # $OLDPWD is created by the first `cd`, so it is marked there; $PWD
    # keeps the mark it was seeded with because `seed_var` replaces the
    # value rather than the record.
    out = shell.mirage("mkdir -p /data/d; cd /data/d; cd /data;"
                       " declare -p PWD OLDPWD")
    assert out == ('declare -x PWD="/data"\n'
                   'declare -x OLDPWD="/data/d"\n')
    env = shell.mirage('env | grep -E "^(PWD|OLDPWD)=" | sort')
    assert env == "OLDPWD=/data/d\nPWD=/data\n"


def test_fork_keeps_pwd_exported():
    # `fork(cwd=...)` rebuilds $PWD to name where the fork is, and has to
    # rebuild the attribute with it: a fresh record would drop the mark
    # and the forked session's env would lose PWD entirely.
    session = SessionState(session_id="s1", cwd="/")
    forked = session.fork(cwd="/data")
    assert VarAttr.EXPORT in forked.vars["PWD"].attrs
    assert env_snapshot(forked)["PWD"] == "/data"


def test_a_plain_variable_still_expands_and_lists(shell):
    # The narrowing is the *process* view only: `$X` and the bare `set`
    # listing are the shell's own view and see every variable.
    assert shell.mirage("X=hello; echo $X") == "hello\n"
    assert "X=hello\n" in shell.mirage("X=hello; set")


# `export -p` prints the whole cluster, not just `-x`, and an array is
# exportable like anything else. Pinned on bash 5.2.37.
ARRAY_EXPORT_CASES = [
    ("export ARR=(a b); declare -p ARR",
     'declare -ax ARR=([0]="a" [1]="b")\n'),
    ("declare -x ARR=(a b); declare -p ARR",
     'declare -ax ARR=([0]="a" [1]="b")\n'),
    ("ARR=(a b); export ARR; declare -p ARR",
     'declare -ax ARR=([0]="a" [1]="b")\n'),
    ("readonly R=1; export R; export -p | grep ' R='", 'declare -rx R="1"\n'),
    ("export ARR=(a b); export -p | grep ARR",
     'declare -ax ARR=([0]="a" [1]="b")\n'),
    # `-n` is the off direction for an array literal too. The store keeps
    # whatever attributes the name already carried, so an unapplied mark
    # left the array exported and GNU's `declare -a` came out
    # `declare -ax`.
    ("declare -x ARR=(a); export -n ARR=(b); declare -p ARR",
     'declare -a ARR=([0]="b")\n'),
    # Both attributes at once: readonly answers first and still owes the
    # export mark.
    ('declare -rx X=1; declare -p X', 'declare -rx X="1"\n'),
]


@pytest.mark.parametrize("cmd,want", ARRAY_EXPORT_CASES)
def test_export_marks_and_renders_arrays(shell, cmd, want):
    assert shell.mirage(cmd) == want


def test_an_exported_array_stays_out_of_the_process_view(shell):
    # Marked, listed by `export -p`, and still absent from `env`: bash
    # puts no array in a child's environment.
    assert shell.mirage("export ARR=(a b); env | grep -c ARR || true") == "0\n"


def test_a_bare_local_declares_without_assigning(shell):
    # The same third state `export Z` has: declared, unset, so `${L-d}`
    # still expands to `d` and `declare -p` prints no `=`. Writing `""`
    # here was the invented-empty-string bug the mark door exists to fix.
    assert shell.mirage('f() { local L; echo "[${L-UNSET}]"; }; f') == (
        "[UNSET]\n")
    assert shell.mirage("f() { local L; declare -p L; }; f") == (
        "declare -- L\n")
    assert shell.mirage("declare D; declare -p D") == "declare -- D\n"
    # An explicit empty value is a value, and prints as one.
    assert shell.mirage('f() { local L=; echo "[${L-UNSET}]"; }; f') == "[]\n"


def test_local_outside_a_function_is_refused(shell):
    _, out, err = shell.mirage_result("local x=1; echo rc=$?")
    assert err == "bash: local: can only be used in a function\n"
    assert out == "rc=1\n"
    # `declare` is the spelling that is legal at top level.
    assert shell.mirage("declare x=1; declare -p x") == 'declare -- x="1"\n'


# A prefix assignment goes in the *command's* environment, which is the
# whole point of the form. Pinned on bash 5.2.37.
PREFIX_CASES = [
    ("TOKEN=x printenv TOKEN", "x\n"),
    ("TOKEN=x env | grep '^TOKEN='", "TOKEN=x\n"),
    # And only for that command: the shell is unchanged afterwards.
    ("TOKEN=x true; echo \"[${TOKEN-unset}]\"", "[unset]\n"),
    # A plain assignment is still a shell variable, not an exported one.
    ("T2=y; env | grep -c '^T2=' || true", "0\n"),
]


@pytest.mark.parametrize("cmd,want", PREFIX_CASES)
def test_a_prefix_assignment_reaches_the_command_environment(shell, cmd, want):
    # `env_snapshot` narrowing to the exported set is what broke this:
    # the prefix was seeded plain, so the command, an installed CLI and a
    # guest runtime all stopped seeing it.
    assert shell.mirage(cmd) == want
