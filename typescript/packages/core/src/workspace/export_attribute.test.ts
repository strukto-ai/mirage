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
import { VarAttr } from '../shell/variable.ts'
import { makeWorkspace, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { SessionState } from './session/session.ts'
import { envSnapshot } from './session/state.ts'

// Every case pinned against GNU bash 5.2.37 on debian:stable-slim.
// The environment is the *exported* set, not every string-valued
// variable, which is the whole subject of this file.
const ENV_CASES: [string, string][] = [
  // A plain assignment is a shell variable and never reaches `env`.
  ['X=hello; export Y=world; env | grep -E "^(X|Y)="', 'Y=world\n'],
  // A name marked but never assigned is not in the environment either:
  // `export Z` declares, it does not give Z a value.
  ['export Z; env | grep -c "^Z="', '0\n'],
  // `export -n` keeps the value and drops the name from the env.
  ['export Y=world; export -n Y; env | grep -c "^Y="', '0\n'],
  // `set -a` marks what is assigned *while it is on*, and nothing else.
  ['B=1; set -a; C=2; set +a; D=3; env | grep -cE "^(B|C|D)="', '1\n'],
  ["set -a; A=auto; env | grep '^A='", 'A=auto\n'],
]

const DECLARE_CASES: [string, string][] = [
  // `--` for a plain scalar, `-x` once exported.
  ['X=hello; export Y=world; declare -p X Y', 'declare -- X="hello"\ndeclare -x Y="world"\n'],
  // The declared-but-unset third state prints bare, with no `=`.
  ['export Z; declare -p Z', 'declare -x Z\n'],
  // `declare -x` on an existing name keeps the value and adds the mark.
  ['E=val; declare -x E; declare -p E', 'declare -x E="val"\n'],
  // `export -n` is the off direction and leaves an ordinary variable.
  ['export Y=world; export -n Y; declare -p Y', 'declare -- Y="world"\n'],
  // Never exported, so `-n` is a no-op rather than an error.
  ['P=plain; export -n P; echo rc=$?; declare -p P', 'rc=0\ndeclare -- P="plain"\n'],
  // Two attributes print in bash's own order (`r` before `x`), which is
  // `attrLetters`' order and not the order they were set in.
  ['export RO=v; readonly RO; declare -p RO', 'declare -rx RO="v"\n'],
  // `set -a` again, read through declare rather than env.
  [
    'B=1; set -a; C=2; set +a; D=3; declare -p B C D',
    'declare -- B="1"\ndeclare -x C="2"\ndeclare -- D="3"\n',
  ],
]

const EXPORT_P_CASES: [string, string][] = [
  // Only exported names, and the unset one prints without a value.
  // Grepped to the three names under test because a real shell (and a
  // mirage session, which exports PWD) carries plenty of others.
  [
    'X=hello; export Y=world; export Z; export -p | grep -E "^declare -x (X|Y|Z)"',
    'declare -x Y="world"\ndeclare -x Z\n',
  ],
  // `export -n` removes it from the listing entirely.
  ['export Q; export -n Q; export -p | grep -c "declare -x Q"', '0\n'],
]

describe('env carries only exported names', () => {
  it.each(ENV_CASES)('%s', async (cmd, want) => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell(cmd))).toBe(want)
    await ws.close()
  })
})

describe('declare -p renders the attributes', () => {
  it.each(DECLARE_CASES)('%s', async (cmd, want) => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell(cmd))).toBe(want)
    await ws.close()
  })
})

describe('export -p lists the exported set', () => {
  it.each(EXPORT_P_CASES)('%s', async (cmd, want) => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell(cmd))).toBe(want)
    await ws.close()
  })
})

describe('the process view is not the shell view', () => {
  it('printenv sees exported names only', async () => {
    // printenv is a separate binary in GNU, so the only names it can
    // possibly see are exported ones; a plain variable exits 1.
    const { ws } = await makeWorkspace()
    const plain = await ws.shell('X=plain; printenv X')
    expect(plain.exitCode).toBe(1)
    expect(stdoutStr(plain)).toBe('')
    expect(stdoutStr(await ws.shell('export X=e; printenv X'))).toBe('e\n')
    await ws.close()
  })

  it('leaves $X and the bare set listing alone', async () => {
    // The narrowing is the *process* view only. `visibleEnv` used to be
    // the same function as `envSnapshot` in TS, so narrowing one would
    // have stopped `$X` resolving a plain assignment.
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell('X=hello; echo $X'))).toBe('hello\n')
    expect(stdoutStr(await ws.shell('X=hello; set'))).toContain('X=hello\n')
    await ws.close()
  })

  it('exports PWD from startup', async () => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell('env'))).toContain('PWD=')
    await ws.close()
  })

  it('exports PWD and OLDPWD after cd', async () => {
    // GNU prints `declare -x OLDPWD` too, and carries both into a child.
    // $OLDPWD is created by the first `cd`, so it is marked there; $PWD
    // keeps the mark it was seeded with because `seedVar` replaces the
    // value rather than the record.
    const { ws } = await makeWorkspace()
    const out = stdoutStr(
      await ws.shell('mkdir -p /ram/d; cd /ram/d; cd /ram; declare -p PWD OLDPWD'),
    )
    expect(out).toBe('declare -x PWD="/ram"\ndeclare -x OLDPWD="/ram/d"\n')
    const env = stdoutStr(await ws.shell('env | grep -E "^(PWD|OLDPWD)=" | sort'))
    expect(env).toBe('OLDPWD=/ram/d\nPWD=/ram\n')
    await ws.close()
  })

  it('keeps PWD exported across a fork', () => {
    // `fork({cwd})` rebuilds $PWD to name where the fork is, and has to
    // rebuild the attribute with it: a fresh record would drop the mark
    // and the forked session's env would lose PWD entirely.
    const session = new SessionState({ sessionId: 's1', cwd: '/' })
    const forked = session.fork({ cwd: '/data' })
    expect(forked.vars.PWD?.attrs.has(VarAttr.Export)).toBe(true)
    expect(envSnapshot(forked).PWD).toBe('/data')
  })
})

describe('declare -p reports an unknown name', () => {
  it('prints the names it knows and refuses the rest', async () => {
    // GNU prints the names it knows, refuses only the ones it does not,
    // and exits 1. Deliberate divergence: mirage's diagnostic carries no
    // `line N:` (GNU says `bash: line 1: declare: NOPE: not found`),
    // matching how every other mirage builtin words its errors.
    const { ws } = await makeWorkspace()
    const io = await ws.shell('G=good; declare -p G NOPE')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('declare -- G="good"\n')
    expect(stderrStr(io)).toBe('bash: declare: NOPE: not found\n')
    await ws.close()
  })
})

describe('an array is exportable like anything else', () => {
  // `export -p` prints the whole cluster, not just `-x`. Pinned on
  // bash 5.2.37.
  const CASES: [string, string][] = [
    ['export ARR=(a b); declare -p ARR', 'declare -ax ARR=([0]="a" [1]="b")\n'],
    ['declare -x ARR=(a b); declare -p ARR', 'declare -ax ARR=([0]="a" [1]="b")\n'],
    ['ARR=(a b); export ARR; declare -p ARR', 'declare -ax ARR=([0]="a" [1]="b")\n'],
    ["readonly R=1; export R; export -p | grep ' R='", 'declare -rx R="1"\n'],
    ['export ARR=(a b); export -p | grep ARR', 'declare -ax ARR=([0]="a" [1]="b")\n'],
    // `-n` is the off direction for an array literal too. The store keeps
    // whatever attributes the name already carried, so an unapplied mark
    // left the array exported and GNU's `declare -a` came out
    // `declare -ax`.
    ['declare -x ARR=(a); export -n ARR=(b); declare -p ARR', 'declare -a ARR=([0]="b")\n'],
    // Both attributes at once: readonly answers first and still owes the
    // export mark.
    ['declare -rx X=1; declare -p X', 'declare -rx X="1"\n'],
  ]
  it.each(CASES)('%s', async (cmd, want) => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell(cmd))).toBe(want)
    await ws.close()
  })

  it('stays out of the process view all the same', async () => {
    // Marked, listed by `export -p`, and still absent from `env`: bash
    // puts no array in a child's environment.
    const { ws } = await makeWorkspace()
    const io = await ws.shell('export ARR=(a b); env | grep -c ARR || true')
    expect(stdoutStr(io)).toBe('0\n')
    await ws.close()
  })
})

describe('a bare local declares without assigning', () => {
  // The same third state `export Z` has: declared, unset, so `${L-d}`
  // still expands to `d` and `declare -p` prints no `=`. Writing `''`
  // here was the invented-empty-string bug the mark door exists to fix.
  const CASES: [string, string][] = [
    ['f() { local L; echo "[${L-UNSET}]"; }; f', '[UNSET]\n'],
    ['f() { local L; declare -p L; }; f', 'declare -- L\n'],
    ['declare D; declare -p D', 'declare -- D\n'],
    // An explicit empty value is a value, and prints as one.
    ['f() { local L=; echo "[${L-UNSET}]"; }; f', '[]\n'],
  ]
  it.each(CASES)('%s', async (cmd, want) => {
    const { ws } = await makeWorkspace()
    expect(stdoutStr(await ws.shell(cmd))).toBe(want)
    await ws.close()
  })

  it('refuses `local` outside a function', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.shell('local x=1; echo rc=$?')
    expect(stderrStr(io)).toBe('bash: local: can only be used in a function\n')
    expect(stdoutStr(io)).toBe('rc=1\n')
    // `declare` is the spelling that is legal at top level.
    expect(stdoutStr(await ws.shell('declare x=1; declare -p x'))).toBe('declare -- x="1"\n')
    await ws.close()
  })
})
