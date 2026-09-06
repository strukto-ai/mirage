// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { makeIntegrationWS } from '../fixtures/integration_fixture.ts'
import { RANDOM, RANDOM_MAX, RANDOM_UNSET } from '../../shell/constants.ts'
import { makeVar, type ShellVar } from '../../shell/variable.ts'
import { Session } from './session.ts'
import { ArithError } from '../../shell/errors.ts'
import {
  conversionScalar,
  nextRandom,
  noteRandomKind,
  randomReader,
  restoreLocals,
  seedFrom,
  seedVar,
  sessionView,
  shadowLocal,
} from './state.ts'

function stored(s: Session): string | undefined {
  const v = s.vars[RANDOM]?.value
  return typeof v === 'string' ? v : undefined
}

describe('RANDOM generator', () => {
  it('evaluates the seed word as arithmetic', () => {
    const s = new Session({ sessionId: 's' })
    s.vars.x = makeVar('42')
    expect(seedFrom('42', s)).toBe(42)
    expect(seedFrom('-1', s)).toBe(2 ** 32 - 1)
    expect(seedFrom('abc', s)).toBe(0)
    expect(seedFrom('', s)).toBe(0)
    expect(seedFrom('1+2', s)).toBe(3)
    expect(seedFrom('0x10', s)).toBe(16)
    expect(seedFrom('010', s)).toBe(8)
    expect(seedFrom('x', s)).toBe(42)
    expect(seedFrom('x*2', s)).toBe(84)
    expect(() => seedFrom('1.5', s)).toThrow(ArithError)
    expect(() => seedFrom('1+', s)).toThrow(ArithError)
    expect(() => seedFrom('08', s)).toThrow(ArithError)
  })

  it('leaves the generator alone on a word that does not evaluate', async () => {
    // bash 5.2.37: `RANDOM=0; echo $RANDOM; RANDOM=1.5; echo $RANDOM`
    // prints the error for 1.5 and then 24386, the second draw of seed 0.
    const s = new Session({ sessionId: 's' })
    expect(nextRandom(s, '0')).toBe(20814)
    await sessionView(s, null).set(RANDOM, '1.5')
    expect(s.diagnostics).toEqual(['1.5: syntax error: invalid character "."'])
    expect(nextRandom(s, stored(s))).toBe(24386)
    expect(nextRandom(s, stored(s))).toBe(149)
  })

  it.each([
    ['1', [16807, 10791, 19566]],
    ['0', [20814, 24386, 149]],
    ['-1', [16807, 10791, 19566]],
    ['4294967338', [17772, 26794, 1435]],
    ['32768', [8403, 3502, 14043]],
    ['1+2', [17653, 593, 9386]],
    ['0x10', [6772, 8817, 18150]],
    ['abc', [20814, 24386, 149]],
  ] as const)('seed %s draws bash 5.2 sequence', (seed, expected) => {
    // Pinned against bash 5.2.37 on debian:stable-slim. -1 truncates to
    // 32 bits, 4294967338 is 42 past 2**32, seed 32768 renders 0 on its
    // first step, which the no-repeat rule redraws, and the last three
    // are arithmetic words: 3, 16, and an unset name.
    const s = new Session({ sessionId: 's' })
    const drawn: (number | null)[] = []
    for (let i = 0; i < 3; i++) drawn.push(nextRandom(s, i === 0 ? seed : stored(s)))
    expect(drawn).toEqual(expected)
  })

  it('is deterministic per seed and pins the python sequence', () => {
    const s = new Session({ sessionId: 'a' })
    const seq: (number | null)[] = []
    for (let i = 0; i < 5; i++) seq.push(nextRandom(s, i === 0 ? '42' : stored(s)))
    expect(seq).toEqual([17772, 26794, 1435, 24388, 11074])
    for (const v of seq) expect(v !== null && v >= 0 && v <= RANDOM_MAX).toBe(true)
  })

  it('reseeds only on a new stored word and writes its value back', () => {
    const s = new Session({ sessionId: 's' })
    const first = nextRandom(s, '7')
    expect(stored(s)).toBe(String(first))
    const again = new Session({ sessionId: 't' })
    expect(nextRandom(again, '7')).toBe(first)
  })

  it('reseeds in a child shell and hands the parent its state back', () => {
    const s = new Session({ sessionId: 's' })
    const parent = [nextRandom(s, '42'), nextRandom(s, stored(s))]
    const saved = s.snapshot()
    const child = nextRandom(s, stored(s))
    expect(s.randomState).not.toBeNull()
    s.restore(saved)
    expect(nextRandom(s, stored(s))).toBe(1435)
    expect(parent).toEqual([17772, 26794])
    expect(child).not.toBe(1435)
  })

  it('does not replay a pending seed in the child, and keeps unset unset', () => {
    const s = new Session({ sessionId: 's' })
    s.vars[RANDOM] = makeVar('42')
    s.snapshot()
    expect(s.randomSeed).toBe('42')
    expect(s.randomState).toBeNull()
    const unset = new Session({ sessionId: 'u' })
    nextRandom(unset, undefined)
    expect(nextRandom(unset, undefined)).toBeNull()
    unset.snapshot()
    expect(nextRandom(unset, undefined)).toBeNull()
  })

  it('unset after a read strips the meaning', () => {
    const s = new Session({ sessionId: 's' })
    expect(nextRandom(s, undefined)).not.toBeNull()
    expect(nextRandom(s, undefined)).toBeNull()
  })
})

describe('child RANDOM isolation', () => {
  for (const drawFirst of [false, true]) {
    it.each([
      'echo $RANDOM | cat >/dev/null',
      'echo x | { read x; : $RANDOM; }',
      'x=$(echo $RANDOM)',
      'x=`echo $RANDOM`',
      'x=$(echo $RANDOM # trailing comment\n)',
      'x=$(echo $(echo $RANDOM))',
      'x=$(: $RANDOM; exit 7)',
      'echo x | { : $RANDOM; exit 7; }',
    ])(`preserves parent state after %s (draw first: ${String(drawFirst)})`, async (child) => {
      const { ws } = await makeIntegrationWS()
      try {
        const prefix = 'RANDOM=42; ' + (drawFirst ? ': $RANDOM; ' : '')
        const io = await ws.execute(prefix + child + '; echo $RANDOM')
        expect(io.exitCode).toBe(0)
        expect(io.stdoutText).toBe(drawFirst ? '26794\n' : '17772\n')
        expect(io.stderrText).toBe('')
      } finally {
        await ws.close()
      }
    })
  }
})

it.each([
  ['RANDOM=1.5; echo ok:$?', 'ok:0\n', 'bash: 1.5:'],
  ['RANDOM=0; : $RANDOM; RANDOM=1.5; echo $RANDOM', '24386\n', 'bash: 1.5:'],
  ['export RANDOM=1.5; echo ok:$?', 'ok:0\n', 'bash: export: 1.5:'],
  ['declare RANDOM=1.5; echo ok:$?', 'ok:0\n', 'bash: declare: 1.5:'],
  ['RANDOM=1.5 x=kept; echo $x', 'kept\n', 'bash: 1.5:'],
  ['{ RANDOM=1.5; echo ok; } 2>/dev/null', 'ok\n', ''],
  ['RANDOM=42; x=$(RANDOM=1.5; echo ok); echo $x $RANDOM', 'ok 17772\n', 'bash: 1.5:'],
  ['unset RANDOM; RANDOM=1.5; echo $RANDOM', '1.5\n', ''],
  ['x=42; RANDOM=x; x=0; echo $RANDOM', '17772\n', ''],
  ['RANDOM=42; RANDOM=$RANDOM; echo $RANDOM', '9401\n', ''],
  ['RANDOM=42; RANDOM=RANDOM; echo $RANDOM', '9401\n', ''],
  ['RANDOM=42; RANDOM=RANDOM+RANDOM; echo $RANDOM', '2815\n', ''],
  ['declare -i n; RANDOM=42; n=RANDOM; echo $n $RANDOM', '17772 26794\n', ''],
])('reports seed assignment diagnostics: %s', async (command, stdout, prefix) => {
  const { ws } = await makeIntegrationWS()
  try {
    const io = await ws.execute(command)
    expect(io.exitCode).toBe(0)
    expect(io.stdoutText).toBe(stdout)
    if (prefix) {
      expect(io.stderrText.startsWith(prefix)).toBe(true)
      expect(io.stderrText).toContain('syntax error')
      expect(io.stderrText.split('\n')).toHaveLength(2)
    } else expect(io.stderrText).toBe('')
  } finally {
    await ws.close()
  }
})

it.each([
  ['RANDOM=42; echo $((RANDOM)) $((RANDOM)) $RANDOM', '17772 26794 1435\n'],
  ['RANDOM=42; echo $((RANDOM+RANDOM)) $RANDOM', '44566 1435\n'],
  [
    'RANDOM=42; echo $((0 && RANDOM)) $((1 || RANDOM)) $((1 ? 5 : RANDOM)) $RANDOM',
    '0 1 5 17772\n',
  ],
  ['x=RANDOM; RANDOM=42; echo $((x)) $((x)) $RANDOM', '17772 26794 1435\n'],
  ["RANDOM=42; (( x=RANDOM )); let 'y=RANDOM'; echo $x $y $RANDOM", '17772 26794 1435\n'],
  [
    'RANDOM=42; for ((i=0; i<2; i++)); do echo $((RANDOM)); done; echo $RANDOM',
    '17772\n26794\n1435\n',
  ],
  ['RANDOM=42; [[ RANDOM -eq 17772 ]]; echo $? $RANDOM', '0 26794\n'],
  ['unset RANDOM; RANDOM=42; echo $((RANDOM)) $((RANDOM))', '42 42\n'],
])('draws RANDOM lazily in arithmetic: %s', async (command, stdout) => {
  const { ws } = await makeIntegrationWS()
  try {
    const io = await ws.execute(command)
    expect(io.exitCode).toBe(0)
    expect(io.stdoutText).toBe(stdout)
    expect(io.stderrText).toBe('')
  } finally {
    await ws.close()
  }
})

// bash 5.2 seeds at the instant of an assignment inside an expression,
// and every read after it draws from the new seed; the session ends
// seeded and advanced by those reads, so the next `$RANDOM` continues
// the sequence rather than restarting it. Pinned in docker.
it.each([
  ['RANDOM=1; echo $((RANDOM=42, RANDOM)) $RANDOM', '17772 26794\n'],
  ['RANDOM=1; echo $((RANDOM=42)) $RANDOM', '42 17772\n'],
  ['RANDOM=1; echo $((RANDOM=42, RANDOM=7, RANDOM)) $RANDOM', '19344 26956\n'],
  ['RANDOM=1; echo $((RANDOM+=1, RANDOM)) $RANDOM', '27726 5703\n'],
  ['RANDOM=1; echo $((RANDOM=42, RANDOM, RANDOM)) $RANDOM', '26794 1435\n'],
  ['RANDOM=1; echo $((RANDOM=42, RANDOM=RANDOM+1)) $RANDOM', '17773 26326\n'],
  ['x=RANDOM; RANDOM=1; echo $((RANDOM=42, x)) $RANDOM', '17772 26794\n'],
  ['RANDOM=1; (( RANDOM=42, x=RANDOM )); echo $x $RANDOM', '17772 26794\n'],
  ['RANDOM=1; let "RANDOM=42, x=RANDOM"; echo $x $RANDOM', '17772 26794\n'],
  [
    'RANDOM=1; for ((RANDOM=42, i=RANDOM; i>0; i=0)); do echo $i; done; echo $RANDOM',
    '17772\n26794\n',
  ],
  ['RANDOM=1; [[ $((RANDOM=42, RANDOM)) -eq 17772 ]]; echo $? $RANDOM', '0 26794\n'],
  ['RANDOM=42; echo $((RANDOM=42, RANDOM-=RANDOM))', '-9022\n'],
  ['RANDOM=42; echo $((RANDOM=42, RANDOM+=RANDOM)) $RANDOM', '44566 2815\n'],
  ['RANDOM=42; a[42]=42; a[17772]=17772; echo $((a[RANDOM])) $RANDOM', '17772 26794\n'],
  ['RANDOM=42; a[17772]=7; echo $((a[RANDOM]+=RANDOM)) ${a[17772]} $RANDOM', '26801 26801 1435\n'],
  ['RANDOM=42; a[17772]=7; echo ${a[RANDOM]} $RANDOM', '7 26794\n'],
  ['RANDOM=42; a[17772]=7; a[RANDOM]=9; echo ${a[17772]} $RANDOM', '9 26794\n'],
  // An arithmetic error keeps the assignments made before it, the seed
  // and its draw included (bash binds each at once).
  ['RANDOM=1; (( RANDOM=42, RANDOM + 1/0 )) 2>/dev/null; echo $? $RANDOM', '1 26794\n'],
  ['x=1; (( x=5, 1/0 )) 2>/dev/null; echo $? $x', '1 5\n'],
  ['x=1; let "x=9, 1/0" 2>/dev/null; echo $? $x', '1 9\n'],
  ['x=1; for ((x=3, 1/0;;)); do :; done 2>/dev/null; echo $x', '3\n'],
  // A seed, a -i coercion and a numeric [[ ]] operand land the
  // assignments they make, through the door.
  ['x=1; RANDOM="x=5"; echo $x $RANDOM', '5 18498\n'],
  ['declare -i n; n="x=7"; echo $n $x', '7 7\n'],
  ['a=(1 2); declare -i n; n="a[1]=9"; echo $n ${a[1]}', '9 9\n'],
  ['RANDOM=1; [[ RANDOM=42 -eq RANDOM ]]; echo $? $RANDOM', '1 26794\n'],
  ['RANDOM=1; [[ RANDOM=42 -eq 42 ]]; echo $? $RANDOM', '0 17772\n'],
  ['x=1; [[ x=5 -eq 5 ]]; echo $? $x', '0 5\n'],
  // The left operand's assignments land before the right reads, and a
  // variable holding an expression lands what it assigns.
  ['unset x; [[ x=5 -eq x ]]; echo $? $x', '0 5\n'],
  ['x=1; [[ x+=4 -eq x ]]; echo $? $x', '0 5\n'],
  ['x="RANDOM=42"; RANDOM=1; echo $((x,RANDOM)) $RANDOM', '17772 26794\n'],
  ['x="y=5"; echo $((x)) $y', '5 5\n'],
  ['x="a[2]=7"; echo $((x)) ${a[2]}', '7 7\n'],
  ['x="y=1, y+=1"; echo $((x + y)) $y', '4 2\n'],
])('seeds RANDOM within the expression that assigns it: %s', async (command, stdout) => {
  const { ws } = await makeIntegrationWS()
  try {
    const io = await ws.execute(command)
    expect(io.exitCode).toBe(0)
    expect(io.stdoutText).toBe(stdout)
    expect(io.stderrText).toBe('')
  } finally {
    await ws.close()
  }
})

it.each([
  // A substring offset or length is arithmetic: it draws, seeds, and
  // assigns, and the second operand sees the first's write. Parenthesized
  // because tree-sitter-bash emits an ERROR node for a bare `=` inside
  // `${v:...}`; the parenthesized form is the same expression to bash.
  ['RANDOM=42; v=abcdefghij; echo ${v:RANDOM%10:1} $RANDOM', 'c 26794\n'],
  ['v=abcdef; echo ${v:(x=1):(y=x+1)} $x $y', 'bc 1 2\n'],
  ['RANDOM=1; v=abc; echo ${v:(RANDOM=42,1)} ${v:RANDOM%3}', 'bc abc\n'],
  ['a=(0 1 2 3 4); echo ${a[@]:(x=1):(y=x+1)} $x $y', '1 2 1 2\n'],
  // So is a subscript, wherever it is spelled: an expansion, an
  // assignment, a literal, `unset`, and `[[ -v ]]`.
  ['RANDOM=1; a[RANDOM=42]=x; echo $RANDOM ${!a[@]}', '17772 42\n'],
  ['a=(0 1 2 3); echo ${a[x=3]} $x', '3 3\n'],
  ['RANDOM=1; a=(0 1); echo ${a[RANDOM=1, 1]} $RANDOM', '1 16807\n'],
  ['x=0; echo ${a[x=1]:=z} ${a[@]} $x', 'z z 1\n'],
  ['a=(0 1 2); unset "a[x=1]"; echo ${a[@]} $x', '0 2 1\n'],
  ['RANDOM=1; a=(0 1 2); [[ -v a[RANDOM%3] ]]; echo $? $RANDOM', '0 10791\n'],
  ['declare -a a=([x=2]=v); echo ${!a[@]} $x', '2 2\n'],
  ['a=([y=3]=v [y+1]=w); echo ${!a[@]} $y', '3 4 3\n'],
  ['unset a; a[i=2]+=x; echo ${!a[@]} $i', '2 2\n'],
  // Inside an expression, the subscript's assignment is seen by the rest
  // of the expression and lands with it.
  ['a[5]=7; unset x; echo $((a[x=5] + x)); echo "$x"', '12\n5\n'],
  ['a[5]=7; echo $((a[y=5]++ + y)) ${a[5]} $y', '12 8 5\n'],
  // A failing operand or coercion lands what it assigned before the
  // error, RANDOM's seed included.
  ['y="x=6,1/0"; [[ 0 -eq y ]] 2>/dev/null; echo rc=$? "x=$x"', 'rc=1 x=6\n'],
  ['RANDOM=1; y="RANDOM=42,1/0"; [[ 0 -eq y ]] 2>/dev/null; echo rc=$? $RANDOM', 'rc=1 17772\n'],
  // An element the first operand assigns is read by the second.
  ['a=(1); v=abcdef; echo "${v:(a[0]=2):(a[0])}" ${a[0]}', 'cd 2\n'],
  // `${RANDOM}` draws like `$RANDOM`, once per expansion. bash draws more
  // than once inside some operators (`${#RANDOM}` consumes two,
  // `${RANDOM/1/X}` three); those are its own re-evaluation and are not
  // modelled, so only the single-draw forms are pinned.
  ['RANDOM=42; echo ${RANDOM} ${RANDOM}', '17772 26794\n'],
  [
    'RANDOM=42; echo "${RANDOM:-x} $RANDOM"; RANDOM=42; echo "${RANDOM:+y} $RANDOM"',
    '17772 26794\ny 26794\n',
  ],
  // A plain `=` evaluates its right side before it resolves the
  // subscript; a compound one reads the target first.
  ['x=0; echo $((a[x++]=x++)); echo "${!a[@]} ${a[@]} $x"', '0\n1 0 2\n'],
])('lands the assignments a subscript or offset makes: %s', async (command, stdout) => {
  const { ws } = await makeIntegrationWS()
  try {
    const io = await ws.execute(command)
    expect(io.exitCode).toBe(0)
    expect(io.stdoutText).toBe(stdout)
    expect(io.stderrText).toBe('')
  } finally {
    await ws.close()
  }
})

it('draws from the pending seed and settles once the door has landed it', () => {
  // The reader is told of the assignment, draws from a scratch
  // generator seeded with it, and replays those draws on the session
  // only once the door has landed the same seed.
  const s = new Session({ sessionId: 's' })
  s.vars[RANDOM] = makeVar('1')
  const reader = randomReader(s)
  expect(reader.read('X')).toBeNull()
  reader.wrote(RANDOM, '42')
  expect([reader.read(RANDOM), reader.read(RANDOM)]).toEqual(['17772', '26794'])
  // The door never seeded 42: nothing to replay.
  reader.settle()
  expect(s.randomState).toBeNull()
  s.randomState = 42
  s.randomSeed = '42'
  s.vars[RANDOM] = makeVar('42')
  reader.settle()
  expect(nextRandom(s, '26794')).toBe(1435)
})

it.each([
  // An operand or subscript that does not evaluate ends the line in
  // bash's words, after landing what was assigned before it.
  ['v=abc; echo "${v:1/0}"; echo after', 'bash: v: 1/0: division by 0\n'],
  ['a=(1 2 3); echo "${a[@]:1/0}"; echo after', 'bash: a[@]: 1/0: division by 0\n'],
  ['a=(1); echo "${a[1/0]}"; echo after', 'bash: 1/0: division by 0\n'],
  ['a=(1); a[1/0]=v; echo after', 'bash: 1/0: division by 0\n'],
  ['a=(1); unset "a[1/0]"; echo after', 'bash: 1/0: division by 0\n'],
  ['a=(1); [[ -v a[1/0] ]]; echo after', 'bash: 1/0: division by 0\n'],
  ['a=(1); a[x=3,1/0]=v; echo after', 'bash: x=3,1/0: division by 0\n'],
])('a subscript or operand that fails ends the line: %s', async (command, stderr) => {
  const { ws } = await makeIntegrationWS()
  try {
    const io = await ws.execute(command)
    expect(io.exitCode).toBe(1)
    expect(io.stdoutText).toBe('')
    expect(io.stderrText).toBe(stderr)
    if (command.includes('x=3')) {
      const landed = await ws.execute('echo $x')
      expect(landed.stdoutText).toBe('3\n')
    }
  } finally {
    await ws.close()
  }
})

it('lays the pending writes over the visible env as a view', async () => {
  // A name reference to an array is a name the visible env cannot serve
  // as a scalar; the operand's env lays its pending writes over that env
  // as a view, so the reference neither breaks the operand nor hides the
  // write.
  const { ws } = await makeIntegrationWS()
  try {
    const io = await ws.execute(
      'declare -a nrb=(1); declare -n nrc=nrb; v=abcdef; echo "${v:(x=1):2}" $x',
    )
    expect(io.stdoutText).toBe('bc 1\n')
    expect(io.stderrText).toBe('')
  } finally {
    await ws.close()
  }
})

it.each([
  // A conditional operator's word expands only when the parameter's state
  // selects it: the draw and the substitution's side effect happen once,
  // or not at all.
  ['RANDOM=42; printf "%s %s\\n" "${RANDOM:-$RANDOM}" "$RANDOM"', '17772 26794\n', ''],
  ['x=1; echo "${x:-$(echo side >&2; echo d)}"', '1\n', ''],
  ['unset u; echo "${u:-$(echo side >&2; echo d)}"', 'd\n', 'side\n'],
  ['x=1; echo "${x:+$(echo side >&2; echo p)}"', 'p\n', 'side\n'],
  ['x=1; echo "${x:?$(echo side >&2; echo m)}"', '1\n', ''],
  ['unset u; echo "${u:=$(echo side >&2; echo v)}" $u', 'v v\n', 'side\n'],
])(
  "a conditional operator's word expands only when selected: %s",
  async (command, stdout, stderr) => {
    const { ws } = await makeIntegrationWS()
    try {
      const io = await ws.execute(command)
      expect(io.exitCode).toBe(0)
      expect(io.stdoutText).toBe(stdout)
      expect(io.stderrText).toBe(stderr)
    } finally {
      await ws.close()
    }
  },
)

describe('RANDOM as an array', () => {
  // bash 5.2 on debian:stable-slim, with three documented gaps: bash
  // prints `declare -ai` because RANDOM carries the integer attribute; a
  // `RANDOM[i]=v`, `${RANDOM[i]:=v}`, `$((RANDOM[i]=v))` or bare
  // `declare -a RANDOM` conversion looks the name up more than once
  // there, so element 0 holds a later draw of the same sequence; and a
  // popped local RANDOM reseeds bash's generator where mirage resumes.
  it.each([
    [
      'declare -a RANDOM=(1 2); printf "%s|%s\\n" "$RANDOM" "${RANDOM[1]}"; echo $RANDOM; declare -p RANDOM',
      '1|2\n1\ndeclare -a RANDOM=([0]="1" [1]="2")\n',
    ],
    [
      'RANDOM=(9); echo $((RANDOM)) ${RANDOM[0]} ${#RANDOM[@]}; RANDOM=3; echo $RANDOM; declare -p RANDOM',
      '9 9 1\n3\ndeclare -a RANDOM=([0]="3")\n',
    ],
    [
      'RANDOM=42; RANDOM+=(3); declare -p RANDOM; echo $RANDOM $RANDOM',
      'declare -a RANDOM=([0]="17772" [1]="3")\n17772 17772\n',
    ],
    [
      'RANDOM=42; RANDOM[1]=5; declare -p RANDOM; echo $RANDOM $RANDOM',
      'declare -a RANDOM=([0]="17772" [1]="5")\n17772 17772\n',
    ],
    [
      'RANDOM=42; declare -a RANDOM; declare -p RANDOM; echo $RANDOM',
      'declare -a RANDOM=([0]="17772")\n17772\n',
    ],
    ['RANDOM=42; declare -A RANDOM; declare -p RANDOM', 'declare -A RANDOM=([0]="17772" )\n'],
    [
      'RANDOM=42; : $((RANDOM[1]=5)); declare -p RANDOM; echo $RANDOM',
      'declare -a RANDOM=([0]="17772" [1]="5")\n17772\n',
    ],
    [
      'RANDOM=42; echo ${RANDOM[1]:=5}; declare -p RANDOM',
      '5\ndeclare -a RANDOM=([0]="17772" [1]="5")\n',
    ],
    ['declare -A RANDOM=([k]=v); echo "[$RANDOM]"; RANDOM=7; echo $RANDOM', '[]\n7\n'],
    [
      'RANDOM=(9); echo "${RANDOM:0:1}|${RANDOM^^}|${RANDOM/9/X}|${RANDOM:-x}|${#RANDOM}"',
      '9|9|X|9|1\n',
    ],
    ['RANDOM=42; (RANDOM=(1); echo $RANDOM); echo $RANDOM', '1\n17772\n'],
    ['RANDOM=42; RANDOM=(1 2); echo $RANDOM; unset RANDOM; RANDOM=5; echo $RANDOM', '1\n5\n'],
    [
      'RANDOM=42; f(){ local RANDOM=(7); g; echo $RANDOM; }; g(){ local RANDOM=(8); echo $RANDOM; }; f; echo $RANDOM',
      '8\n7\n17772\n',
    ],
    ['RANDOM=42; f(){ local RANDOM=5; echo $RANDOM; }; f; echo $RANDOM', '5\n17772\n'],
    [
      'RANDOM=42; f(){ declare -a RANDOM; echo "[$RANDOM]" ${#RANDOM[@]}; }; f; echo $RANDOM $RANDOM',
      '[] 0\n17772 26794\n',
    ],
    ['unset RANDOM; f(){ local RANDOM=(7); echo $RANDOM; }; f; echo "[$RANDOM]"', '7\n[]\n'],
  ])('ends the special meaning: %s', async (command, stdout) => {
    const { ws } = await makeIntegrationWS()
    try {
      const io = await ws.execute(command)
      expect(io.stderrText).toBe('')
      expect(io.exitCode).toBe(0)
      expect(io.stdoutText).toBe(stdout)
    } finally {
      await ws.close()
    }
  })

  it('ends the meaning through every store door on a non-string', async () => {
    const s = new Session({ sessionId: 's' })
    seedVar(s, RANDOM, ['1', '2'])
    expect(nextRandom(s, undefined)).toBeNull()
    expect(s.vars[RANDOM]?.value).toEqual(['1', '2'])
    const t = new Session({ sessionId: 't' })
    await sessionView(t, null).set(RANDOM, { k: 'v' })
    expect(nextRandom(t, undefined)).toBeNull()
    expect(t.vars[RANDOM]?.value).toEqual({ k: 'v' })
    const u = new Session({ sessionId: 'u' })
    noteRandomKind(u, 'other', ['1'])
    expect(nextRandom(u, undefined)).not.toBeNull()
  })

  it('conversion draws once for a live RANDOM', () => {
    const s = new Session({ sessionId: 's' })
    seedVar(s, RANDOM, '42')
    expect(conversionScalar(s, RANDOM)).toBe('17772')
    expect(s.vars[RANDOM]?.value).toBe('17772')
    seedVar(s, 'x', '5')
    expect(conversionScalar(s, 'x')).toBe('5')
    expect(conversionScalar(s, 'absent')).toBeUndefined()
    const u = new Session({ sessionId: 'u' })
    u.randomSeed = RANDOM_UNSET
    expect(conversionScalar(u, RANDOM)).toBeUndefined()
  })

  it('a local RANDOM parks the marker and restores it', () => {
    const s = new Session({ sessionId: 's' })
    seedVar(s, RANDOM, '42')
    expect(nextRandom(s, '42')).toBe(17772)
    const frame = new Map<string, ShellVar | null>()
    shadowLocal(s, frame, RANDOM)
    shadowLocal(s, frame, RANDOM)
    expect(frame.get(RANDOM)?.value).toBe('17772')
    expect(s.localRandom).toEqual(['17772'])
    expect(nextRandom(s, '17772')).toBeNull()
    seedVar(s, RANDOM, ['7'])
    restoreLocals(s, frame)
    expect(s.vars[RANDOM]?.value).toBe('17772')
    expect(s.localRandom).toEqual([])
    expect(nextRandom(s, '17772')).toBe(26794)
  })
})
