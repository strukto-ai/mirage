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
  // tree-sitter-bash cannot parse a $-spelled offset (${v:$o}); mirage
  // fails loudly (exit 2) rather than emit the mis-parse. Spell it
  // ${v:o} or ${v:$((o))}, both supported.
  ['v=hello; o=2; echo "X${v:$o}Y"', 2, '', 'bash: ${v}: bad substitution\n'],
  ['v=hello; o=2; echo "${v:$o:2}"', 2, '', 'bash: ${v}: bad substitution\n'],
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
