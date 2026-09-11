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

from mirage import MountMode, RAMResource, Workspace
from mirage.shell.constants import RANDOM, RANDOM_MAX, RANDOM_UNSET
from mirage.shell.errors import ArithError
from mirage.shell.variable import ShellVar
from mirage.workspace.session import Session
from mirage.workspace.session.state import (conversion_scalar, next_random,
                                            note_random_kind, random_reader,
                                            restore_locals, seed_from,
                                            seed_var, set_var, shadow_local)


def test_seed_from_evaluates_the_word_as_arithmetic():
    s = Session(session_id="s")
    s.vars["x"] = ShellVar("42")
    assert seed_from("42", s) == 42
    assert seed_from("-1", s) == (1 << 32) - 1
    assert seed_from("abc", s) == 0
    assert seed_from("", s) == 0
    assert seed_from("1+2", s) == 3
    assert seed_from("0x10", s) == 16
    assert seed_from("010", s) == 8
    assert seed_from("x", s) == 42
    assert seed_from("x*2", s) == 84
    with pytest.raises(ArithError):
        seed_from("1.5", s)
    with pytest.raises(ArithError):
        seed_from("1+", s)
    with pytest.raises(ArithError):
        seed_from("08", s)


@pytest.mark.asyncio
async def test_an_unevaluable_word_leaves_the_generator_alone():
    # bash 5.2.37: `RANDOM=0; echo $RANDOM; RANDOM=1.5; echo $RANDOM`
    # prints the error for 1.5 and then 24386, the second draw of seed 0.
    s = Session(session_id="s")
    assert next_random(s, "0") == 20814
    await set_var(s, None, RANDOM, "1.5")
    assert s._diagnostics == ['1.5: syntax error: invalid character "."']
    assert next_random(s, s.vars[RANDOM].value) == 24386
    assert next_random(s, s.vars[RANDOM].value) == 149


@pytest.mark.parametrize("seed,expected", [
    ("1", [16807, 10791, 19566]),
    ("0", [20814, 24386, 149]),
    ("-1", [16807, 10791, 19566]),
    ("4294967338", [17772, 26794, 1435]),
    ("32768", [8403, 3502, 14043]),
    ("1+2", [17653, 593, 9386]),
    ("0x10", [6772, 8817, 18150]),
    ("abc", [20814, 24386, 149]),
])
def test_seeded_sequences_are_bash_5_2s(seed, expected):
    # Pinned against bash 5.2.37 on debian:stable-slim. -1 truncates to
    # 32 bits, 4294967338 is 42 past 2**32, seed 32768 renders 0 on its
    # first step, which the no-repeat rule redraws, and the last three
    # are arithmetic words: 3, 16, and an unset name.
    s = Session(session_id="s")
    drawn = [
        next_random(s, seed if i == 0 else s.vars[RANDOM].value)
        for i in range(3)
    ]
    assert drawn == expected


def test_seeded_sequence_is_deterministic_and_bounded():
    a = Session(session_id="a")
    b = Session(session_id="b")
    seq_a = [
        next_random(a, "42" if i == 0 else a.vars[RANDOM].value)
        for i in range(5)
    ]
    seq_b = [
        next_random(b, "42" if i == 0 else b.vars[RANDOM].value)
        for i in range(5)
    ]
    assert seq_a == seq_b
    assert all(v is not None and 0 <= v <= RANDOM_MAX for v in seq_a)
    # bash 5.2's sequence from seed 42, so both languages pin bash's.
    assert seq_a == [17772, 26794, 1435, 24388, 11074]


def test_write_back_reseeds_only_on_a_new_word():
    s = Session(session_id="s")
    first = next_random(s, "7")
    stored = s.vars[RANDOM].value
    assert stored == str(first)
    second = next_random(s, stored)
    assert second != first or s.vars[RANDOM].value != stored


def test_unset_after_a_read_strips_the_meaning():
    s = Session(session_id="s")
    assert next_random(s, None) is not None
    assert next_random(s, None) is None


def test_a_child_shell_reseeds_and_the_parent_gets_its_state_back():
    s = Session(session_id="s")
    parent = [next_random(s, "42"), next_random(s, s.vars[RANDOM].value)]
    saved = s.snapshot()
    child = next_random(s, s.vars[RANDOM].value)
    assert s._random_state is not None
    s.restore(saved)
    assert next_random(s, s.vars[RANDOM].value) == 1435
    assert parent == [17772, 26794] and child != 1435


def test_a_child_shell_does_not_replay_a_pending_seed():
    s = Session(session_id="s")
    seed_var(s, RANDOM, "42")
    s.snapshot()
    assert s._random_seed == "42" and s._random_state is None
    unset = Session(session_id="u")
    next_random(unset, None)
    assert next_random(unset, None) is None
    unset.snapshot()
    assert next_random(unset, None) is None


@pytest.mark.asyncio
async def test_random_expands_in_the_shell():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute(
        'RANDOM=42; a=$RANDOM; RANDOM=42; b=$RANDOM; echo $a $b')
    assert await io.stdout_str() == "17772 17772\n"
    io = await ws.execute('echo $RANDOM $RANDOM')
    x, y = (await io.stdout_str()).split()
    assert x != y and x.isdigit() and y.isdigit()
    io = await ws.execute(
        'RANDOM=42; a=$RANDOM; RANDOM=42; (: $RANDOM); b=$RANDOM; echo $a $b')
    assert await io.stdout_str() == "17772 17772\n"
    io = await ws.execute(
        "RANDOM='1+2'; a=$RANDOM; RANDOM=0x10; b=$RANDOM; x=42; RANDOM=x; "
        "c=$RANDOM; RANDOM=0; d=$RANDOM; RANDOM=1.5; e=$RANDOM; "
        "echo $a $b $c $d $e")
    assert await io.stdout_str() == "17653 6772 17772 20814 24386\n"
    io = await ws.execute('unset RANDOM; echo "[$RANDOM]"')
    assert await io.stdout_str() == "[]\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("child", [
    'echo $RANDOM | cat >/dev/null',
    'echo x | { read x; : $RANDOM; }',
    'x=$(echo $RANDOM)',
    'x=`echo $RANDOM`',
    'x=$(echo $RANDOM # trailing comment\n)',
    'x=$(echo $(echo $RANDOM))',
    'x=$(: $RANDOM; exit 7)',
    'echo x | { : $RANDOM; exit 7; }',
])
@pytest.mark.parametrize("draw_first", [False, True])
async def test_child_random_reads_preserve_the_parent_sequence(
        child, draw_first):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        prefix = 'RANDOM=42; ' + (': $RANDOM; ' if draw_first else '')
        io = await ws.execute(prefix + child + '; echo $RANDOM')
        assert io.exit_code == 0
        assert await io.stdout_str() == ('26794\n'
                                         if draw_first else '17772\n')
        assert await io.stderr_str() == ''
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("command,stdout,prefix", [
    ('RANDOM=1.5; echo ok:$?', 'ok:0\n', 'bash: 1.5:'),
    ('RANDOM=0; : $RANDOM; RANDOM=1.5; echo $RANDOM', '24386\n', 'bash: 1.5:'),
    ('export RANDOM=1.5; echo ok:$?', 'ok:0\n', 'bash: export: 1.5:'),
    ('declare RANDOM=1.5; echo ok:$?', 'ok:0\n', 'bash: declare: 1.5:'),
    ('RANDOM=1.5 x=kept; echo $x', 'kept\n', 'bash: 1.5:'),
    ('{ RANDOM=1.5; echo ok; } 2>/dev/null', 'ok\n', ''),
    ('RANDOM=42; x=$(RANDOM=1.5; echo ok); echo $x $RANDOM', 'ok 17772\n',
     'bash: 1.5:'),
    ('unset RANDOM; RANDOM=1.5; echo $RANDOM', '1.5\n', ''),
    ('x=42; RANDOM=x; x=0; echo $RANDOM', '17772\n', ''),
    ('RANDOM=42; RANDOM=$RANDOM; echo $RANDOM', '9401\n', ''),
    ('RANDOM=42; RANDOM=RANDOM; echo $RANDOM', '9401\n', ''),
    ('RANDOM=42; RANDOM=RANDOM+RANDOM; echo $RANDOM', '2815\n', ''),
    ('declare -i n; RANDOM=42; n=RANDOM; echo $n $RANDOM', '17772 26794\n',
     ''),
])
async def test_random_seed_diagnostics(command, stdout, prefix):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute(command)
    assert io.exit_code == 0
    assert await io.stdout_str() == stdout
    err = await io.stderr_str()
    if prefix:
        assert err.startswith(prefix)
        assert 'syntax error' in err
        assert err.count('\n') == 1
    else:
        assert err == ''


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command, stdout",
    [('RANDOM=42; echo $((RANDOM)) $((RANDOM)) $RANDOM', '17772 26794 1435\n'),
     ('RANDOM=42; echo $((RANDOM+RANDOM)) $RANDOM', '44566 1435\n'),
     ('RANDOM=42; echo $((0 && RANDOM)) $((1 || RANDOM)) '
      '$((1 ? 5 : RANDOM)) $RANDOM', '0 1 5 17772\n'),
     ('x=RANDOM; RANDOM=42; echo $((x)) $((x)) $RANDOM', '17772 26794 1435\n'),
     ("RANDOM=42; (( x=RANDOM )); let 'y=RANDOM'; echo $x $y $RANDOM",
      '17772 26794 1435\n'),
     ('RANDOM=42; for ((i=0; i<2; i++)); do echo $((RANDOM)); '
      'done; echo $RANDOM', '17772\n26794\n1435\n'),
     ('RANDOM=42; [[ RANDOM -eq 17772 ]]; echo $? $RANDOM', '0 26794\n'),
     ('unset RANDOM; RANDOM=42; echo $((RANDOM)) $((RANDOM))', '42 42\n')])
async def test_arithmetic_random_reads_are_lazy(command, stdout):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute(command)
        assert io.exit_code == 0
        assert await io.stdout_str() == stdout
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


# bash 5.2 seeds at the instant of an assignment inside an expression,
# and every read after it draws from the new seed; the session ends
# seeded and advanced by those reads, so the next `$RANDOM` continues
# the sequence rather than restarting it. Pinned in docker.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,stdout",
    [
        ('RANDOM=1; echo $((RANDOM=42, RANDOM)) $RANDOM', '17772 26794\n'),
        ('RANDOM=1; echo $((RANDOM=42)) $RANDOM', '42 17772\n'),
        ('RANDOM=1; echo $((RANDOM=42, RANDOM=7, RANDOM)) $RANDOM',
         '19344 26956\n'),
        ('RANDOM=1; echo $((RANDOM+=1, RANDOM)) $RANDOM', '27726 5703\n'),
        ('RANDOM=1; echo $((RANDOM=42, RANDOM, RANDOM)) $RANDOM',
         '26794 1435\n'),
        ('RANDOM=1; echo $((RANDOM=42, RANDOM=RANDOM+1)) $RANDOM',
         '17773 26326\n'),
        ('x=RANDOM; RANDOM=1; echo $((RANDOM=42, x)) $RANDOM',
         '17772 26794\n'),
        ('RANDOM=1; (( RANDOM=42, x=RANDOM )); echo $x $RANDOM',
         '17772 26794\n'),
        ('RANDOM=1; let "RANDOM=42, x=RANDOM"; echo $x $RANDOM',
         '17772 26794\n'),
        ('RANDOM=1; for ((RANDOM=42, i=RANDOM; i>0; i=0)); do echo $i; done; '
         'echo $RANDOM', '17772\n26794\n'),
        ('RANDOM=1; [[ $((RANDOM=42, RANDOM)) -eq 17772 ]]; echo $? $RANDOM',
         '0 26794\n'),
        ('RANDOM=42; echo $((RANDOM=42, RANDOM-=RANDOM))', '-9022\n'),
        ('RANDOM=42; echo $((RANDOM=42, RANDOM+=RANDOM)) $RANDOM',
         '44566 2815\n'),
        ('RANDOM=42; a[42]=42; a[17772]=17772; echo $((a[RANDOM])) $RANDOM',
         '17772 26794\n'),
        ('RANDOM=42; a[17772]=7; echo $((a[RANDOM]+=RANDOM)) ${a[17772]} '
         '$RANDOM', '26801 26801 1435\n'),
        ('RANDOM=42; a[17772]=7; echo ${a[RANDOM]} $RANDOM', '7 26794\n'),
        ('RANDOM=42; a[17772]=7; a[RANDOM]=9; echo ${a[17772]} $RANDOM',
         '9 26794\n'),
        # An arithmetic error keeps the assignments made before it, the
        # seed and its draw included (bash binds each at once).
        ('RANDOM=1; (( RANDOM=42, RANDOM + 1/0 )) 2>/dev/null; '
         'echo $? $RANDOM', '1 26794\n'),
        ('x=1; (( x=5, 1/0 )) 2>/dev/null; echo $? $x', '1 5\n'),
        ('x=1; let "x=9, 1/0" 2>/dev/null; echo $? $x', '1 9\n'),
        ('x=1; for ((x=3, 1/0;;)); do :; done 2>/dev/null; echo $x', '3\n'),
        # A seed, a -i coercion and a numeric [[ ]] operand land the
        # assignments they make, through the door.
        ('x=1; RANDOM="x=5"; echo $x $RANDOM', '5 18498\n'),
        ('declare -i n; n="x=7"; echo $n $x', '7 7\n'),
        ('a=(1 2); declare -i n; n="a[1]=9"; echo $n ${a[1]}', '9 9\n'),
        ('RANDOM=1; [[ RANDOM=42 -eq RANDOM ]]; echo $? $RANDOM', '1 26794\n'),
        ('RANDOM=1; [[ RANDOM=42 -eq 42 ]]; echo $? $RANDOM', '0 17772\n'),
        ('x=1; [[ x=5 -eq 5 ]]; echo $? $x', '0 5\n'),
        # The left operand's assignments land before the right reads, and
        # a variable holding an expression lands what it assigns.
        ('unset x; [[ x=5 -eq x ]]; echo $? $x', '0 5\n'),
        ('x=1; [[ x+=4 -eq x ]]; echo $? $x', '0 5\n'),
        ('x="RANDOM=42"; RANDOM=1; echo $((x,RANDOM)) $RANDOM',
         '17772 26794\n'),
        ('x="y=5"; echo $((x)) $y', '5 5\n'),
        ('x="a[2]=7"; echo $((x)) ${a[2]}', '7 7\n'),
        ('x="y=1, y+=1"; echo $((x + y)) $y', '4 2\n'),
    ])
async def test_arithmetic_random_assignment_seeds_within_the_expression(
        command, stdout):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute(command)
        assert io.exit_code == 0
        assert await io.stdout_str() == stdout
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.parametrize(
    "command,stdout",
    [
        # A substring offset or length is arithmetic: it draws, seeds,
        # and assigns, and the second operand sees the first's write.
        # Parenthesized because tree-sitter-bash emits an ERROR node for
        # a bare `=` inside `${v:...}`; the parenthesized form is the
        # same expression to bash.
        ('RANDOM=42; v=abcdefghij; echo ${v:RANDOM%10:1} $RANDOM', 'c 26794\n'
         ),
        ('v=abcdef; echo ${v:(x=1):(y=x+1)} $x $y', 'bc 1 2\n'),
        ('RANDOM=1; v=abc; echo ${v:(RANDOM=42,1)} ${v:RANDOM%3}', 'bc abc\n'),
        ('a=(0 1 2 3 4); echo ${a[@]:(x=1):(y=x+1)} $x $y', '1 2 1 2\n'),
        # So is a subscript, wherever it is spelled: an expansion, an
        # assignment, a literal, `unset`, and `[[ -v ]]`.
        ('RANDOM=1; a[RANDOM=42]=x; echo $RANDOM ${!a[@]}', '17772 42\n'),
        ('a=(0 1 2 3); echo ${a[x=3]} $x', '3 3\n'),
        ('RANDOM=1; a=(0 1); echo ${a[RANDOM=1, 1]} $RANDOM', '1 16807\n'),
        ('x=0; echo ${a[x=1]:=z} ${a[@]} $x', 'z z 1\n'),
        ('a=(0 1 2); unset "a[x=1]"; echo ${a[@]} $x', '0 2 1\n'),
        ('RANDOM=1; a=(0 1 2); [[ -v a[RANDOM%3] ]]; echo $? $RANDOM',
         '0 10791\n'),
        ('declare -a a=([x=2]=v); echo ${!a[@]} $x', '2 2\n'),
        ('a=([y=3]=v [y+1]=w); echo ${!a[@]} $y', '3 4 3\n'),
        ('unset a; a[i=2]+=x; echo ${!a[@]} $i', '2 2\n'),
        # Inside an expression, the subscript's assignment is seen by the
        # rest of the expression and lands with it.
        ('a[5]=7; unset x; echo $((a[x=5] + x)); echo "$x"', '12\n5\n'),
        ('a[5]=7; echo $((a[y=5]++ + y)) ${a[5]} $y', '12 8 5\n'),
        # A failing operand or coercion lands what it assigned before the
        # error, RANDOM's seed included.
        ('y="x=6,1/0"; [[ 0 -eq y ]] 2>/dev/null; echo rc=$? "x=$x"',
         'rc=1 x=6\n'),
        ('RANDOM=1; y="RANDOM=42,1/0"; [[ 0 -eq y ]] 2>/dev/null; '
         'echo rc=$? $RANDOM', 'rc=1 17772\n'),
        # An element the first operand assigns is read by the second.
        ('a=(1); v=abcdef; echo "${v:(a[0]=2):(a[0])}" ${a[0]}', 'cd 2\n'),
        # `${RANDOM}` draws like `$RANDOM`, once per expansion. bash draws
        # more than once inside some operators (`${#RANDOM}` consumes
        # two, `${RANDOM/1/X}` three); those are its own re-evaluation
        # and are not modelled, so only the single-draw forms are pinned.
        ('RANDOM=42; echo ${RANDOM} ${RANDOM}', '17772 26794\n'),
        ('RANDOM=42; echo "${RANDOM:-x} $RANDOM"; RANDOM=42; '
         'echo "${RANDOM:+y} $RANDOM"', '17772 26794\ny 26794\n'),
        # A plain `=` evaluates its right side before it resolves the
        # subscript; a compound one reads the target first.
        ('x=0; echo $((a[x++]=x++)); echo "${!a[@]} ${a[@]} $x"', '0\n1 0 2\n'
         ),
    ])
@pytest.mark.asyncio
async def test_subscripts_and_offsets_land_their_assignments(command, stdout):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute(command)
        assert io.exit_code == 0
        assert await io.stdout_str() == stdout
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


def test_random_reader_draws_from_the_pending_seed_and_settles():
    # The reader is told of the assignment, draws from a scratch
    # generator seeded with it, and replays those draws on the session
    # only once the door has landed the same seed.
    session = Session(session_id="s")
    session.vars[RANDOM] = ShellVar("1")
    reader = random_reader(session)
    assert reader.read("X") is None
    reader.wrote("RANDOM", "42")
    assert [reader.read(RANDOM) for _ in range(2)] == ["17772", "26794"]
    # The door never seeded 42: nothing to replay.
    reader.settle()
    assert session._random_state is None
    session._random_state, session._random_seed = 42, "42"
    session.vars[RANDOM] = ShellVar("42")
    reader.settle()
    assert next_random(session, session.vars[RANDOM].value) == 1435


@pytest.mark.parametrize(
    "command,stderr",
    [
        # An operand or subscript that does not evaluate ends the line in
        # bash's words, after landing what was assigned before it.
        ('v=abc; echo "${v:1/0}"; echo after', 'bash: v: 1/0: division by 0\n'
         ),
        ('a=(1 2 3); echo "${a[@]:1/0}"; echo after',
         'bash: a[@]: 1/0: division by 0\n'),
        ('a=(1); echo "${a[1/0]}"; echo after', 'bash: 1/0: division by 0\n'),
        ('a=(1); a[1/0]=v; echo after', 'bash: 1/0: division by 0\n'),
        ('a=(1); unset "a[1/0]"; echo after', 'bash: 1/0: division by 0\n'),
        ('a=(1); [[ -v a[1/0] ]]; echo after', 'bash: 1/0: division by 0\n'),
        ('a=(1); a[x=3,1/0]=v; echo after', 'bash: x=3,1/0: division by 0\n'),
    ])
@pytest.mark.asyncio
async def test_a_subscript_or_operand_that_fails_ends_the_line(
        command, stderr):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute(command)
        assert io.exit_code == 1
        assert await io.stdout_str() == ""
        assert await io.stderr_str() == stderr
        if "x=3" in command:
            landed = await ws.execute("echo $x")
            assert await landed.stdout_str() == "3\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_operand_env_is_a_view_over_the_visible_env():
    # A name reference to an array is a name the visible env cannot
    # serve as a scalar; the operand's env lays its pending writes over
    # that env as a view, so the reference neither breaks the operand
    # nor hides the write.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute("declare -a nrb=(1); declare -n nrc=nrb; "
                              'v=abcdef; echo "${v:(x=1):2}" $x')
        assert await io.stdout_str() == "bc 1\n"
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.parametrize(
    "command,stdout,stderr",
    [
        # A conditional operator's word expands only when the parameter's
        # state selects it: the draw and the substitution's side effect
        # happen once, or not at all.
        ('RANDOM=42; printf "%s %s\\n" "${RANDOM:-$RANDOM}" "$RANDOM"',
         '17772 26794\n', ''),
        ('x=1; echo "${x:-$(echo side >&2; echo d)}"', '1\n', ''),
        ('unset u; echo "${u:-$(echo side >&2; echo d)}"', 'd\n', 'side\n'),
        ('x=1; echo "${x:+$(echo side >&2; echo p)}"', 'p\n', 'side\n'),
        ('x=1; echo "${x:?$(echo side >&2; echo m)}"', '1\n', ''),
        ('unset u; echo "${u:=$(echo side >&2; echo v)}" $u', 'v v\n',
         'side\n'),
    ])
@pytest.mark.asyncio
async def test_a_conditional_operators_word_expands_only_when_selected(
        command, stdout, stderr):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        io = await ws.execute(command)
        assert io.exit_code == 0
        assert await io.stdout_str() == stdout
        assert await io.stderr_str() == stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("command,stdout", [
    ('declare -a RANDOM=(1 2); printf "%s|%s\\n" "$RANDOM" "${RANDOM[1]}"; '
     'echo $RANDOM; declare -p RANDOM',
     '1|2\n1\ndeclare -a RANDOM=([0]="1" [1]="2")\n'),
    ('RANDOM=(9); echo $((RANDOM)) ${RANDOM[0]} ${#RANDOM[@]}; RANDOM=3; '
     'echo $RANDOM; declare -p RANDOM',
     '9 9 1\n3\ndeclare -a RANDOM=([0]="3")\n'),
    ('RANDOM=42; RANDOM+=(3); declare -p RANDOM; echo $RANDOM $RANDOM',
     'declare -a RANDOM=([0]="17772" [1]="3")\n17772 17772\n'),
    ('RANDOM=42; RANDOM[1]=5; declare -p RANDOM; echo $RANDOM $RANDOM',
     'declare -a RANDOM=([0]="17772" [1]="5")\n17772 17772\n'),
    ('RANDOM=42; declare -a RANDOM; declare -p RANDOM; echo $RANDOM',
     'declare -a RANDOM=([0]="17772")\n17772\n'),
    ('RANDOM=42; declare -A RANDOM; declare -p RANDOM',
     'declare -A RANDOM=([0]="17772" )\n'),
    ('RANDOM=42; : $((RANDOM[1]=5)); declare -p RANDOM; echo $RANDOM',
     'declare -a RANDOM=([0]="17772" [1]="5")\n17772\n'),
    ('RANDOM=42; echo ${RANDOM[1]:=5}; declare -p RANDOM',
     '5\ndeclare -a RANDOM=([0]="17772" [1]="5")\n'),
    ('declare -A RANDOM=([k]=v); echo "[$RANDOM]"; RANDOM=7; echo $RANDOM',
     '[]\n7\n'),
    ('RANDOM=(9); echo "${RANDOM:0:1}|${RANDOM^^}|${RANDOM/9/X}|${RANDOM:-x}|'
     '${#RANDOM}"', '9|9|X|9|1\n'),
    ('RANDOM=42; (RANDOM=(1); echo $RANDOM); echo $RANDOM', '1\n17772\n'),
    ('RANDOM=42; RANDOM=(1 2); echo $RANDOM; unset RANDOM; RANDOM=5; '
     'echo $RANDOM', '1\n5\n'),
    ('RANDOM=42; f(){ local RANDOM=(7); g; echo $RANDOM; }; '
     'g(){ local RANDOM=(8); echo $RANDOM; }; f; echo $RANDOM',
     '8\n7\n17772\n'),
    ('RANDOM=42; f(){ local RANDOM=5; echo $RANDOM; }; f; echo $RANDOM',
     '5\n17772\n'),
    ('RANDOM=42; f(){ declare -a RANDOM; echo "[$RANDOM]" ${#RANDOM[@]}; }; '
     'f; echo $RANDOM $RANDOM', '[] 0\n17772 26794\n'),
    ('unset RANDOM; f(){ local RANDOM=(7); echo $RANDOM; }; f; '
     'echo "[$RANDOM]"', '7\n[]\n'),
])
async def test_an_array_on_random_ends_its_special_meaning(command, stdout):
    # bash 5.2 on debian:stable-slim, with three documented gaps: bash
    # prints `declare -ai` because RANDOM carries the integer attribute;
    # a `RANDOM[i]=v`, `${RANDOM[i]:=v}`, `$((RANDOM[i]=v))` or bare
    # `declare -a RANDOM` conversion looks the name up more than once
    # there, so element 0 holds a later draw of the same sequence; and a
    # popped local RANDOM reseeds bash's generator where mirage resumes.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute(command)
    assert await io.stderr_str() == ''
    assert io.exit_code == 0
    assert await io.stdout_str() == stdout


@pytest.mark.asyncio
async def test_every_store_door_ends_the_meaning_on_a_non_string():
    s = Session(session_id="s")
    seed_var(s, RANDOM, ["1", "2"])
    assert next_random(s, None) is None
    assert s.vars[RANDOM].value == ["1", "2"]
    t = Session(session_id="t")
    await set_var(t, None, RANDOM, {"k": "v"})
    assert next_random(t, None) is None
    assert t.vars[RANDOM].value == {"k": "v"}
    u = Session(session_id="u")
    note_random_kind(u, "other", ["1"])
    assert next_random(u, None) is not None


def test_conversion_scalar_draws_once_for_a_live_random():
    s = Session(session_id="s")
    seed_var(s, RANDOM, "42")
    assert conversion_scalar(s, RANDOM) == "17772"
    assert s.vars[RANDOM].value == "17772"
    seed_var(s, "x", "5")
    assert conversion_scalar(s, "x") == "5"
    assert conversion_scalar(s, "absent") is None
    u = Session(session_id="u")
    u._random_seed = RANDOM_UNSET
    assert conversion_scalar(u, RANDOM) is None


def test_a_local_random_parks_the_marker_and_restores_it():
    s = Session(session_id="s")
    seed_var(s, RANDOM, "42")
    assert next_random(s, "42") == 17772
    frame: dict[str, ShellVar | None] = {}
    shadow_local(s, frame, RANDOM)
    shadow_local(s, frame, RANDOM)
    assert frame[RANDOM] is not None and frame[RANDOM].value == "17772"
    assert s._local_random == ["17772"]
    assert next_random(s, "17772") is None
    seed_var(s, RANDOM, ["7"])
    restore_locals(s, frame)
    assert s.vars[RANDOM].value == "17772"
    assert s._local_random == []
    assert next_random(s, "17772") == 26794
