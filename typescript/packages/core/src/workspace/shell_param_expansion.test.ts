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
import { makeIntegrationWS, run, runResult } from './fixtures/integration_fixture.ts'

const CASES: [string, string][] = [
  ['v=hello; o=2; echo "X${v:$o}Y"', 'XlloY\n'],
  ['v=hello; o=2; echo "${v:$o:2}"', 'll\n'],
  ['X=hi; echo "${X:-fallback}"', 'hi\n'],
  ['echo "${UNSET:-fallback}"', 'fallback\n'],
  ['X=""; echo "${X:-fallback}"', 'fallback\n'],
  ['X=""; echo "${X-fallback}"', '\n'],
  ['echo "${UNSET-fallback}"', 'fallback\n'],
  ['X=hi; echo "${X:+yes}"', 'yes\n'],
  ['echo "${UNSET:+yes}"', '\n'],
  ['X=""; echo "${X:+yes}"', '\n'],
  ['X=""; echo "${X+yes}"', 'yes\n'],
  ['X=hello; echo "${#X}"', '5\n'],
  ['X=""; echo "${#X}"', '0\n'],
  ['X=hello; echo "${X:1:3}"', 'ell\n'],
  ['X=hello; echo "${X:1}"', 'ello\n'],
  ['X=hello; echo "${X: -3}"', 'llo\n'],
  ['X=foobar; echo "${X#foo}"', 'bar\n'],
  ['X=foobar; echo "${X%bar}"', 'foo\n'],
  ['X=a/b/c/d; echo "${X##*/}"', 'd\n'],
  ['X=a/b/c/d; echo "${X%%/*}"', 'a\n'],
  ['X=a/b/c/d; echo "${X#*/}"', 'b/c/d\n'],
  ['X=a/b/c/d; echo "${X%/*}"', 'a/b/c\n'],
  ['X=foobarfoo; echo "${X/foo/baz}"', 'bazbarfoo\n'],
  ['X=foobarfoo; echo "${X//foo/baz}"', 'bazbarbaz\n'],
  ['X=foobar; echo "${X/foo/}"', 'bar\n'],
  ['X=hello; echo "${X^^}"', 'HELLO\n'],
  ['X=HELLO; echo "${X,,}"', 'hello\n'],
  ['X=hello; echo "${X^}"', 'Hello\n'],
  ['X=HELLO; echo "${X,}"', 'hELLO\n'],
  ['X=hello; Y=X; echo "${!Y}"', 'hello\n'],
  ['echo "${UNSET:=def}"; echo "$UNSET"', 'def\ndef\n'],
  ['X=""; echo "${X:=def}"; echo "$X"', 'def\ndef\n'],
  ['X=hi; echo "${X:=def}"; echo "$X"', 'hi\nhi\n'],
  ['X=""; echo "start${X=def}end"; echo "[$X]"', 'startend\n[]\n'],
  ['echo "${UNSET=def}"; echo "$UNSET"', 'def\ndef\n'],
  ['X=""; echo "start${X?msg}end"', 'startend\n'],
  ['X=hi; echo "${X:?msg}"', 'hi\n'],
  ['X=banana; echo "${X/a*/Y}"', 'bY\n'],
  ['X=hello; echo "${X/l?/Y}"', 'heYo\n'],
  ['X=hello; echo "${X/#he/HE}"', 'HEllo\n'],
  ['X=hello; echo "${X/#lo/Y}"', 'hello\n'],
  ['X=hello; echo "${X/%lo/LO}"', 'helLO\n'],
  ['X=hello; echo "${X/%he/Y}"', 'hello\n'],
  ['X="a b c"; echo "${X// /_}"', 'a_b_c\n'],
  ['X=hello; echo "${X^^[el]}"', 'hELLo\n'],
  ['D=inner; echo "${UNSET_PN:-$D}"', 'inner\n'],
  ['echo "${UNSET_PN2:-$(echo subbed)}"', 'subbed\n'],
  ['EXT=.txt; F=a.txt; echo "${F%$EXT}"', 'a\n'],
  ['PAT=l; X=hello; echo "${X//$PAT/L}"', 'heLLo\n'],
  ['X=abcdef; echo "${X:1+1}"', 'cdef\n'],
  ['X=abcdef; O=2; echo "${X:O:2}"', 'cd\n'],
  ['X=abcdef; echo "${X:1:-2}"', 'bcd\n'],
  ['X=hello; echo "${X#?}"', 'ello\n'],
  ['X=hello; echo "${X%[lo]*}"', 'hell\n'],
  ['X=abc; echo "${X#[!x]}"', 'bc\n'],
  ['X=abc; echo "${X#[^x]}"', 'bc\n'],
  ['f() { local T=inner; REF=T; echo "${!REF}"; }; f', 'inner\n'],
]

const ERROR_CASES: [string, number, string, string][] = [
  ['echo ${UNSET:?}; echo after', 127, '', 'bash: UNSET: parameter null or not set\n'],
  ['echo ${UNSET:?custom msg}', 127, '', 'bash: UNSET: custom msg\n'],
  ['echo ${UNSET?}', 127, '', 'bash: UNSET: parameter not set\n'],
  [
    '(echo ${UNSET:?}); echo after code=$?',
    0,
    'after code=1\n',
    'bash: UNSET: parameter null or not set\n',
  ],
  [
    'echo ${UNSET:?} | cat; echo after code=$?',
    0,
    'after code=0\n',
    'bash: UNSET: parameter null or not set\n',
  ],
]

describe('parameter expansion error operators', () => {
  for (const [cmd, exitCode, stdout, stderr] of ERROR_CASES) {
    it(cmd, async () => {
      const { ws } = await makeIntegrationWS()
      try {
        expect(await runResult(ws, cmd)).toEqual([exitCode, stdout, stderr])
      } finally {
        await ws.close()
      }
    })
  }

  it('assigns inside a function local without leaking', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(
        await run(ws, 'f(){ local v=; echo "${v:=zz}"; echo "inner=$v"; }; f; echo "outer=[$v]"'),
      ).toBe('zz\ninner=zz\nouter=[]\n')
    } finally {
      await ws.close()
    }
  })
})

// An unset parameter slices to nothing and its bounds are never evaluated;
// a set one evaluates them. Pinned on bash 5.2.37 (debian:stable-slim).
const SLICE_CASES: [string, number, string, string][] = [
  ['echo "a${sales[vid]:.2f}b"', 0, 'ab\n', ''],
  ['declare -A m; echo "a${m[k]:.2f}b"', 0, 'ab\n', ''],
  ['a=(); a[5]=x; echo "a${a[vid]:.2f}b"', 0, 'ab\n', ''],
  ['x=hi; echo "[${x[1]:.2f}]"', 0, '[]\n', ''],
  ['echo "a${x:.2f}b"', 0, 'ab\n', ''],
  ['echo "a${1:.2f}b"', 0, 'ab\n', ''],
  ['unset a; echo "[${a[@]:.2f}]" "[${a[*]:.2f}]"', 0, '[] []\n', ''],
  ['declare -A m; echo "[${m[@]:.2f}]"', 0, '[]\n', ''],
  ['unset x; echo "[${x:y=1}]"; echo "y=$y"', 0, '[]\ny=\n', ''],
  ['unset x; echo "[${x:$((1/0))}]"; echo after', 0, '[]\nafter\n', ''],
  [
    'sales=(1 2); echo "a${sales[vid]:.2f}b"',
    1,
    '',
    'bash: sales[vid]: .2f: syntax error: operand expected (error token is ".2f")\n',
  ],
  [
    'x=; echo "a${x:.2f}b"',
    1,
    '',
    'bash: x: .2f: syntax error: operand expected (error token is ".2f")\n',
  ],
  [
    'set -- ""; echo "a${1:.2f}b"',
    1,
    '',
    'bash: 1: .2f: syntax error: operand expected (error token is ".2f")\n',
  ],
  [
    'a=(); a[3]=x; echo "[${a[@]:.2f}]"',
    1,
    '',
    'bash: a[@]: .2f: syntax error: operand expected (error token is ".2f")\n',
  ],
  ['set -u; echo "a${x:.2f}b"', 127, '', 'bash: x: unbound variable\n'],
  ['set -- a ""; echo "[${2-u}] [${2+s}] [${3-u}] [${3+s}]"', 0, '[] [s] [u] []\n', ''],
]

describe('substring of an unset parameter', () => {
  for (const [cmd, exitCode, stdout, stderr] of SLICE_CASES) {
    it(cmd, async () => {
      const { ws } = await makeIntegrationWS()
      try {
        expect(await runResult(ws, cmd)).toEqual([exitCode, stdout, stderr])
      } finally {
        await ws.close()
      }
    })
  }
})

// `set -u` over subscripted references and the arithmetic in a subscript
// or a substring bound, pinned on bash 5.2.37 (debian:stable-slim).
const NOUNSET_CASES: [string, number, string, string][] = [
  ['set -u; a=(1); echo "[${a[5]}]"; echo after', 127, '', 'bash: a[5]: unbound variable\n'],
  ['set -u; a=(1); i=5; echo "[${a[i]:1}]"', 127, '', 'bash: a[i]: unbound variable\n'],
  ['set -u; a=(1); echo "[${a[5]#x}]"', 127, '', 'bash: a[5]: unbound variable\n'],
  ['set -u; declare -A m; k=x; echo "[${m[$k]}]"', 127, '', 'bash: m[$k]: unbound variable\n'],
  [
    'set -u; x=s; echo "[${x[0]}]"; echo "[${x[1]}]"',
    127,
    '[s]\n',
    'bash: x[1]: unbound variable\n',
  ],
  ['set -u; arr=(1); echo "a${arr[vid]:.2f}b"', 127, '', 'bash: vid: unbound variable\n'],
  [
    'set -u; arr=(1); vid=3; echo "a${arr[vid]:.2f}b"',
    127,
    '',
    'bash: arr[vid]: unbound variable\n',
  ],
  ['set -u; a=(1); echo "[${a[i+4]}]"', 127, '', 'bash: i: unbound variable\n'],
  ['set -u; w=v; a=(1); echo "[${a[w]}]"', 127, '', 'bash: v: unbound variable\n'],
  ['set -u; x=hello; echo "[${x:1:v}]"', 127, '', 'bash: v: unbound variable\n'],
  ['set -u; a=(x y z); echo "[${a[@]:v}]"', 127, '', 'bash: v: unbound variable\n'],
  ["set -u; a=(1); unset 'a[v]'; echo after", 127, '', 'bash: v: unbound variable\n'],
  ['set -u; a=(1); [[ -v a[v] ]]; echo after', 127, '', 'bash: v: unbound variable\n'],
  ['set -u; a[v]=1; echo after', 127, '', 'bash: v: unbound variable\n'],
  [
    'set -u; (a=(1); echo "[${a[5]}]"); echo "rc=$?"',
    0,
    'rc=1\n',
    'bash: a[5]: unbound variable\n',
  ],
  [
    'set -u; a=(1); echo "[${a[5]-d}] [${a[5]:-d}] [${a[5]+s}] [${a[5]:+s}] [${#a[5]}]"',
    0,
    '[d] [d] [] [] [0]\n',
    '',
  ],
  ['set -u; a=(1); echo "[${a[5]:=z}] [${a[5]}]"', 0, '[z] [z]\n', ''],
  ['set -u; a=(1); echo "[${a[x=0]}] x=$x"', 0, '[1] x=0\n', ''],
  ['set -u; a=(); a[1]=x; b=(7 8); echo "[${b[a]}]"', 0, '[7]\n', ''],
  ['set -u; f() { local i=1; local a=(x y); echo "[${a[i]}]"; }; f', 0, '[y]\n', ''],
]

describe('set -u over subscripts and substring bounds', () => {
  for (const [cmd, exitCode, stdout, stderr] of NOUNSET_CASES) {
    it(cmd, async () => {
      const { ws } = await makeIntegrationWS()
      try {
        expect(await runResult(ws, cmd)).toEqual([exitCode, stdout, stderr])
      } finally {
        await ws.close()
      }
    })
  }
})

describe('parameter expansion operators', () => {
  for (const [cmd, expected] of CASES) {
    it(cmd, async () => {
      const { ws } = await makeIntegrationWS()
      try {
        expect(await run(ws, cmd)).toBe(expected)
      } finally {
        await ws.close()
      }
    })
  }
})
